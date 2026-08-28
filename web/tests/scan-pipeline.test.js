import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Task 14: scan-pipeline.js now POSTs scans to the session-scoped endpoint
// via api-client.js's apiFetch (Task 13), and trusts the server-returned
// `status` verbatim. Mock the apiFetch wrapper instead of global.fetch --
// this replaces the earlier module-scope `global.fetch = vi.fn()` (whose
// missing restore leaked a mock into sibling files; see commit 83ea622).
const { lookupCardMock, TEST_SESSION_ID } = vi.hoisted(() => ({
  lookupCardMock: vi.fn(),
  TEST_SESSION_ID: 'session-under-test',
}));

vi.mock('../api-client.js', () => ({
  apiFetch: vi.fn((url, init) => {
    expect(url).toBe(`/api/attendance-sessions/${TEST_SESSION_ID}/scans`);
    expect(init.method).toBe('POST');
    // performSubmit passes a plain object as `body` (the real apiFetch is
    // what JSON-encodes it); tolerate either shape so the mock stays honest
    // whether or not the wrapper stringifies.
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    return lookupCardMock(body.cardCode).then((result) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(result),
    }));
  }),
}));

const { ScanPipeline } = await import('../scan-pipeline.js');
const { apiFetch } = await import('../api-client.js');

/**
 * Waits for all currently-pending microtasks to drain -- unlike a fixed
 * number of `await Promise.resolve()` ticks, this doesn't need updating
 * every time submitScan()'s apiFetch/json/logEvent chain gains or loses a
 * promise hop, since a macrotask callback only runs after the microtask
 * queue is empty.
 */
function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

/** The server's normalized attendance record for a resolved + roster-matched scan. */
function successResult(overrides = {}) {
  return {
    id: 'record-1',
    attendanceSessionId: TEST_SESSION_ID,
    ltiUserId: 'user-1',
    institutionalId: '1000000',
    status: 'present',
    lookupErrorKind: null,
    scannedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** The server's normalized record when the identity lookup failed. */
function errorResult(kind, overrides = {}) {
  return {
    id: 'record-1',
    attendanceSessionId: TEST_SESSION_ID,
    ltiUserId: null,
    institutionalId: null,
    status: 'lookup_error',
    lookupErrorKind: kind,
    scannedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** The server's normalized record for an identity not on this session's roster snapshot. */
function unexpectedResult(overrides = {}) {
  return {
    id: 'record-1',
    attendanceSessionId: TEST_SESSION_ID,
    ltiUserId: null,
    institutionalId: '9999999',
    status: 'unexpected',
    lookupErrorKind: null,
    scannedAt: new Date().toISOString(),
    ...overrides,
  };
}

function parsedReport(cardCode) {
  return { valid: true, hasPayload: true, trimmedCardCode: cardCode };
}

function makePipeline() {
  const callbacks = {
    onRecordCreated: vi.fn(),
    onRecordUpdated: vi.fn(),
    onLatestScanUpdate: vi.fn(),
    onStatsChanged: vi.fn(),
  };
  const pipeline = new ScanPipeline({ sessionId: TEST_SESSION_ID, callbacks });
  return { pipeline, callbacks };
}

beforeEach(() => {
  lookupCardMock.mockReset();
  apiFetch.mockClear();
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
    await flushAsync(); // let _resolveScan's continuation run

    const updated = callbacks.onRecordUpdated.mock.calls.at(-1)[0];
    expect(updated.status).toBe('present');
    expect(updated.institutionalId).toBe('1000000');
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
    deferredA.resolve(successResult({ institutionalId: '1111111' }));
    await flushAsync();

    expect(callbacks.onLatestScanUpdate).not.toHaveBeenCalled();

    // B's (newer) lookup resolves -- this one SHOULD update the latest display.
    deferredB.resolve(successResult({ institutionalId: '2222222' }));
    await flushAsync();

    expect(callbacks.onLatestScanUpdate).toHaveBeenCalledTimes(1);
    expect(callbacks.onLatestScanUpdate.mock.calls[0][0].institutionalId).toBe('2222222');
  });

  it('suppresses a duplicate scan of a card that already has a live (present) row, without re-looking-up', async () => {
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

  it('retries the lookup in place when a duplicate scan arrives for a row stuck in lookup_error', async () => {
    const { pipeline, callbacks } = makePipeline();
    const deferred2 = createDeferred();
    lookupCardMock
      .mockReturnValueOnce(Promise.resolve(errorResult('network')))
      .mockReturnValueOnce(deferred2.promise);

    pipeline.handleParsedReport(parsedReport('CARD001'));
    await flushAsync();

    expect(callbacks.onRecordUpdated.mock.calls.at(-1)[0].status).toBe('lookup_error');
    expect(pipeline.getStats().lookupErrors).toBe(1);

    pipeline.handleParsedReport(parsedReport('CARD001')); // retry via duplicate scan

    expect(lookupCardMock).toHaveBeenCalledTimes(2);
    // Retrying flips the row back to pending and un-counts the prior failure.
    expect(pipeline.getStats().lookupErrors).toBe(0);
    expect(callbacks.onRecordCreated).toHaveBeenCalledTimes(1); // no new row created

    deferred2.resolve(successResult());
    await flushAsync();

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

  it('records a lookup_error status (not "not on roster") when the lookup times out', async () => {
    const { pipeline, callbacks } = makePipeline();
    lookupCardMock.mockReturnValueOnce(Promise.resolve(errorResult('timeout')));

    pipeline.handleParsedReport(parsedReport('CARD001'));
    await flushAsync();

    const updated = callbacks.onRecordUpdated.mock.calls.at(-1)[0];
    expect(updated.status).toBe('lookup_error');
    expect(pipeline.getStats().lookupErrors).toBe(1);
  });

  it('trusts the server-provided status verbatim rather than recomputing a roster match locally', async () => {
    const { pipeline, callbacks } = makePipeline();
    lookupCardMock.mockReturnValueOnce(Promise.resolve(unexpectedResult()));

    pipeline.handleParsedReport(parsedReport('CARD001'));
    await flushAsync();

    const updated = callbacks.onRecordUpdated.mock.calls.at(-1)[0];
    expect(updated.status).toBe('unexpected');
    expect(pipeline.getStats().unexpected).toBe(1);
  });

  it('marks an identity resolved and matched on the server as present', async () => {
    const { pipeline, callbacks } = makePipeline();
    lookupCardMock.mockReturnValueOnce(Promise.resolve(successResult({ institutionalId: '1000000' })));

    pipeline.handleParsedReport(parsedReport('CARD001'));
    await flushAsync();

    const updated = callbacks.onRecordUpdated.mock.calls.at(-1)[0];
    expect(updated.status).toBe('present');
    expect(pipeline.getStats().totalAccepted).toBe(1);
  });

  it('ignores a parsed report when no attendance session is active (sessionId null) and does not call the transport', async () => {
    const callbacks = {
      onRecordCreated: vi.fn(),
      onRecordUpdated: vi.fn(),
      onLatestScanUpdate: vi.fn(),
      onStatsChanged: vi.fn(),
    };
    const pipeline = new ScanPipeline({ sessionId: null, callbacks });

    pipeline.handleParsedReport(parsedReport('CARD001'));
    await flushAsync();

    expect(callbacks.onRecordCreated).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
