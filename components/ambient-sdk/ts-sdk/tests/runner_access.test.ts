import { checkRunnerAccess } from '../src';

describe('runner access', () => {
  afterEach(() => jest.restoreAllMocks());
  it('preserves the method, identity and encoded session', async () => {
    const request = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const identityFixture = 'user-identity';
    await checkRunnerAccess({ baseUrl: 'https://api.test', token: identityFixture }, 'session/id', 'PUT');
    expect(request).toHaveBeenCalledWith('https://api.test/api/ambient/v1/sessions/session%2Fid/runner/access', expect.objectContaining({
      method: 'PUT', headers: expect.objectContaining({ Authorization: 'Bearer user-identity' }),
    }));
  });
  it('propagates denial and rejects invalid action without a request', async () => {
    const request = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(checkRunnerAccess({ baseUrl: 'https://api.test' }, 'session', 'POST')).rejects.toMatchObject({ statusCode: 403 });
    request.mockClear();
    await expect(checkRunnerAccess({ baseUrl: 'https://api.test' }, 'session', 'GET', 'stop')).rejects.toThrow('unsupported');
    expect(request).not.toHaveBeenCalled();
  });
});
