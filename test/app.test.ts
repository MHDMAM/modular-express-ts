import { formatStatus, SUCCESS_STATUS } from '@utils/HttpException';
import { startTestApp, TestApp } from './support/testApp';

describe('App', () => {
  let app: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    app = await startTestApp();
    baseUrl = app.url;
  });

  afterAll(() => app.close());

  it('should auto-load module routes and respond with success status and metadata', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(body.status).toBe(SUCCESS_STATUS);
    expect(body.payload.healthy).toBe(true);
    expect(body._metadata.processingTime).toBeGreaterThanOrEqual(0);
  });

  it('should echo an incoming x-request-id header', async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { 'x-request-id': 'test-ref' } });

    expect(res.headers.get('x-request-id')).toBe('test-ref');
  });

  it('should return 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    const body: any = await res.json();

    expect(res.status).toBe(404);
    expect(body.status).toBe(formatStatus(4));
  });

  it('should return 400 for an invalid JSON body', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid',
    });
    const body: any = await res.json();

    expect(res.status).toBe(400);
    expect(body.status).toBe(formatStatus(2));
  });
});
