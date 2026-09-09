import { getFakeServer } from './globalSetup.js';

export default async function globalTeardown() {
  await getFakeServer()?.close();
}
