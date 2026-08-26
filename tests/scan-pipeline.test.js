import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const lookupCardMock = vi.fn();
vi.mock('../lookup.js', () => ({
  lookupCard: (...args) => lookupCardMock(...args),
}));

const { ScanPipeline } = await import('../scan-pipeline.js');

/** A promise whose resolution is controlled externally, to simulate an in-flight async lookup. */
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function successResult(overrides = {}) {
  return {
    ok: true,
    universityId: '1000000',
    firstName: 'Jane',
    lastName: 'Smith',
    email: 'jane.smith@example.edu',
    raw: {},
    error: null,
    ...overrides,
  };
}

function errorResult(kind, overrides = {}) {
  return {
    ok: false,
    universityId: null,
    firstName: null,
    lastName: null,
    email: null,
    raw: null,
    error: { kind, message: `simulated ${kind}` },
    ...overrides,
  };
}

function parsedReport(cardCode) {
  return { valid: true, hasPayload: true, trimmedCardCode: cardCode };
}

function makePipeline({ rosterEnabled = false, rosterIndex = new Map() } = {}) {
  const callbacks = {
    onRecordCreated: vi.fn(),
    onRecordUpdated: vi.fn(),
    onLatestScanUpdate: vi.fn(),
    onStatsChanged: vi.fn(),
  };
  const pipeline = new ScanPipeline({
    getRosterState: () => ({ enabled: rosterEnabled, index: rosterIndex }),
    callbacks,
  });
  return { pipeline, callbacks };
}

beforeEach(() => {
  lookupCardMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ScanPipeline', () => {
  it('creates a pending record immediately, then resolves it on lookup success', async () => {
    const { pipeline, callbacks } = makePipeline();
    const deferred = createDeferred();
    lookupCardMock.mockReturnValueOnce(deferred.promise);

    pipeline.handleParsedReport(parsedReport('CARD001'));

    expect(callbacks.onRecordCreated).toHaveBeenCalledTimes(1);
    const created = callbacks.onRecordCreated.mock.calls[0][0];
    expect(created.status).toBe('pending');

    deferred.resolve(successResult());
    await deferred.promise;
    await Promise.resolve(); // let _resolveScan's continuation run

    const updated = callbacks.onRecordUpdated.mock.calls.at(-1)[0];
    expect(updated.status).toBe('accepted');
    expect(updated.universityId).toBe('1000000');
    expect(pipeline.getStats().totalAccepted).toBe(1);
  });

  it('two different cards scanned rapidly both get their own record and both look up', () => {
    const { pipeline, callbacks } = makePipeline();
    lookupCardMock.mockReturnValue(createDeferred().promise);

    pipeline.handleParsedReport(parsedReport('CARD_A'));
    pipeline.handleParsedReport(parsedReport('CARD_B'));

    expect(callbacks.onRecordCreated).toHaveBeenCalledTimes(2);
    expect(lookupCardMock).toHaveBeenCalledTimes(2);
    expect(lookupCardMock).toHaveBeenNthCalledWith(1, 'CARD_A');
    expect(lookupCardMock).toHaveBeenNthCalledWith(2, 'CARD_B');
    const ids = callbacks.onRecordCreated.mock.calls.map((c) => c[0].id);
    expect(new Set(ids).size).toBe(2);
  });

  it('does not let a slower, older lookup clobber a newer scan as the "latest" display', async () => {
    const { pipeline, callbacks } = makePipeline();
    const deferredA = createDeferred();
    const deferredB = createDeferred();
    lookupCardMock.mockReturnValueOnce(deferredA.promise).mockReturnValueOnce(deferredB.promise);

    pipeline.handleParsedReport(parsedReport('CARD_A')); // latestScanId = A
    pipeline.handleParsedReport(parsedReport('CARD_B')); // latestScanId = B

    // A's (older) lookup finally resolves, after B has already become latest.
    deferredA.resolve(successResult({ universityId: '1111111' }));
    await deferredA.promise;
    await Promise.resolve();

    expect(callbacks.onLatestScanUpdate).not.toHaveBeenCalled();

    // B's (newer) lookup resolves -- this one SHOULD update the latest display.
    deferredB.resolve(successResult({ universityId: '2222222' }));
    await deferredB.promise;
    await Promise.resolve();

    expect(callbacks.onLatestScanUpdate).toHaveBeenCalledTimes(1);
    expect(callbacks.onLatestScanUpdate.mock.calls[0][0].universityId).toBe('2222222');
  });

  it('suppresses a duplicate scan of a card that already has a live (accepted) row, without re-looking-up', async () => {
    const { pipeline, callbacks } = makePipeline();
    lookupCardMock.mockReturnValueOnce(Promise.resolve(successResult()));

    pipeline.handleParsedReport(parsedReport('CARD001'));
    await Promise.resolve();
    await Promise.resolve();

    pipeline.handleParsedReport(parsedReport('CARD001')); // duplicate, same live row

    expect(lookupCardMock).toHaveBeenCalledTimes(1);
    expect(callbacks.onRecordCreated).toHaveBeenCalledTimes(1);
    expect(pipeline.getStats().suppressedDuplicates).toBe(1);
  });

  it('retries the lookup in place when a duplicate scan arrives for a row stuck in lookup-error', async () => {
    const { pipeline, callbacks } = makePipeline();
    const deferred2 = createDeferred();
    lookupCardMock
      .mockReturnValueOnce(Promise.resolve(errorResult('network')))
      .mockReturnValueOnce(deferred2.promise);

    pipeline.handleParsedReport(parsedReport('CARD001'));
    await Promise.resolve();
    await Promise.resolve();

    expect(callbacks.onRecordUpdated.mock.calls.at(-1)[0].status).toBe('lookup-error');
    expect(pipeline.getStats().lookupErrors).toBe(1);

    pipeline.handleParsedReport(parsedReport('CARD001')); // retry via duplicate scan

    expect(lookupCardMock).toHaveBeenCalledTimes(2);
    // Retrying flips the row back to pending and un-counts the prior failure.
    expect(pipeline.getStats().lookupErrors).toBe(0);
    expect(callbacks.onRecordCreated).toHaveBeenCalledTimes(1); // no new row created

    deferred2.resolve(successResult());
    await deferred2.promise;
    await Promise.resolve();

    expect(pipeline.getStats().totalAccepted).toBe(1);
    expect(pipeline.getStats().lookupErrors).toBe(0);
  });

  it('suppresses a duplicate scan within the suppress window after its record was removed', async () => {
    vi.useFakeTimers();
    const { pipeline, callbacks } = makePipeline();
    lookupCardMock.mockReturnValue(Promise.resolve(successResult()));

    pipeline.handleParsedReport(parsedReport('CARD001'));
    await vi.runOnlyPendingTimersAsync();

    const created = callbacks.onRecordCreated.mock.calls[0][0];
    pipeline.removeRecord(created.id); // clears recordIdByCardCode, but not lastAcceptedByCode

    pipeline.handleParsedReport(parsedReport('CARD001')); // within DUPLICATE_SUPPRESS_WINDOW_MS

    expect(callbacks.onRecordCreated).toHaveBeenCalledTimes(1); // no second record
    expect(pipeline.getStats().suppressedDuplicates).toBe(1);
    expect(lookupCardMock).toHaveBeenCalledTimes(1); // no second lookup
  });

  it('accepts a new scan of the same card once the suppress window has elapsed', async () => {
    vi.useFakeTimers();
    const { pipeline, callbacks } = makePipeline();
    lookupCardMock.mockReturnValue(Promise.resolve(successResult()));

    pipeline.handleParsedReport(parsedReport('CARD001'));
    await vi.runOnlyPendingTimersAsync();
    const created = callbacks.onRecordCreated.mock.calls[0][0];
    pipeline.removeRecord(created.id);

    vi.advanceTimersByTime(3000); // past the 2000ms suppress window

    pipeline.handleParsedReport(parsedReport('CARD001'));
    await vi.runOnlyPendingTimersAsync();

    expect(callbacks.onRecordCreated).toHaveBeenCalledTimes(2);
    expect(lookupCardMock).toHaveBeenCalledTimes(2);
  });

  it('does not update a record deleted while its lookup was still pending', async () => {
    const { pipeline, callbacks } = makePipeline();
    const deferred = createDeferred();
    lookupCardMock.mockReturnValueOnce(deferred.promise);

    pipeline.handleParsedReport(parsedReport('CARD001'));
    const created = callbacks.onRecordCreated.mock.calls[0][0];

    pipeline.removeRecord(created.id);
    callbacks.onRecordUpdated.mockClear();

    deferred.resolve(successResult());
    await deferred.promise;
    await Promise.resolve();

    expect(callbacks.onRecordUpdated).not.toHaveBeenCalled();
    expect(pipeline.getRecords()).toHaveLength(0);
  });

  it('records a lookup-error status (not "not on roster") when the lookup times out', async () => {
    const { pipeline, callbacks } = makePipeline({ rosterEnabled: true });
    lookupCardMock.mockReturnValueOnce(Promise.resolve(errorResult('timeout')));

    pipeline.handleParsedReport(parsedReport('CARD001'));
    await Promise.resolve();
    await Promise.resolve();

    const updated = callbacks.onRecordUpdated.mock.calls.at(-1)[0];
    expect(updated.status).toBe('lookup-error');
    expect(updated.rosterStatus).toBe('lookup-error');
    expect(pipeline.getStats().lookupErrors).toBe(1);
  });

  it('marks an identity resolved but not present on the roster as unexpected', async () => {
    const rosterIndex = new Map([['9999999', { id: '9999999', name: 'On Roster' }]]);
    const { pipeline, callbacks } = makePipeline({ rosterEnabled: true, rosterIndex });
    lookupCardMock.mockReturnValueOnce(Promise.resolve(successResult({ universityId: '1000000' })));

    pipeline.handleParsedReport(parsedReport('CARD001'));
    await Promise.resolve();
    await Promise.resolve();

    const updated = callbacks.onRecordUpdated.mock.calls.at(-1)[0];
    expect(updated.rosterStatus).toBe('unexpected');
    expect(pipeline.getStats().unexpected).toBe(1);
    expect(pipeline.getStats().expected).toBe(0);
  });

  it('marks an identity present on the roster as expected and attaches the roster row', async () => {
    const rosterIndex = new Map([['1000000', { id: '1000000', name: 'Jane Smith', section: '01' }]]);
    const { pipeline, callbacks } = makePipeline({ rosterEnabled: true, rosterIndex });
    lookupCardMock.mockReturnValueOnce(Promise.resolve(successResult({ universityId: '1000000' })));

    pipeline.handleParsedReport(parsedReport('CARD001'));
    await Promise.resolve();
    await Promise.resolve();

    const updated = callbacks.onRecordUpdated.mock.calls.at(-1)[0];
    expect(updated.rosterStatus).toBe('expected');
    expect(updated.rosterData).toEqual({ id: '1000000', name: 'Jane Smith', section: '01' });
    expect(pipeline.getStats().expected).toBe(1);
  });
});
