import { retryUntilDefined } from './retry';

export async function getForkUrl(client: { transport: { url?: string } }): Promise<string> {
  return retryUntilDefined(() => client.transport.url, {
    maxRetries: 10,
    retryDelay: 500,
    onRetry: attempt => {
      console.log(`Waiting for fork URL... (attempt ${attempt}/10)`);
    }
  }).then(url => {
    if (!url) {
      throw new Error('Fork URL is not set. Client transport URL is required.');
    }
    return url;
  });
}
