// Stands in for a third-party automation module in tests. Its path contains
// /modules/fake-automation/, which is how the bridge attributes a log entry.

export function failLater(delayMs) {
  setTimeout(() => console.error('fake-automation | workflow failed', new Error('target is not defined')), delayMs);
}

export function warnNow(text) {
  console.warn(text);
}
