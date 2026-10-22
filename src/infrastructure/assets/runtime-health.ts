import { validateImage } from './image-validator';

// The ready state depends on a real native decode, also exercised in packaged smoke tests.
export async function verifyImageRuntime(): Promise<void> {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
    'base64',
  );
  await validateImage(png, AbortSignal.timeout(30000));
}
