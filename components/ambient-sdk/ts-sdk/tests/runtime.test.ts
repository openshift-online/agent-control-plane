import { RuntimeAPI } from '../src';

const testServiceIdentity = 'service-identity';

describe('RuntimeAPI versioned updates', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps null clears and sends the expected version with service auth', async () => {
    const request = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'session', runtime_version: 8 }), { status: 200 }));
    const runtime = new RuntimeAPI({ baseUrl: 'https://api.test', token: testServiceIdentity });
    await runtime.patchSession('session/id', 7, { runner_generation: null, expected_phase: 'Stopping' });
    expect(request).toHaveBeenCalledWith('https://api.test/api/ambient/v1/runtime/sessions/session%2Fid', expect.objectContaining({
      method: 'PATCH', headers: expect.objectContaining({ Authorization: 'Bearer service-identity' }),
      body: JSON.stringify({ runner_generation: null, expected_phase: 'Stopping', runtime_version: 7 }),
    }));
  });

  it('surfaces a version conflict without retrying', async () => {
    const request = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 'conflict' }), { status: 409 }));
    await expect(new RuntimeAPI({ baseUrl: 'https://api.test' }).patchProject('project', 1, { gateway_id: 'gateway' })).rejects.toMatchObject({ statusCode: 409 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
