interface Frame {
  readonly url: string;
}
interface Contents {
  readonly mainFrame: Frame;
}
interface SenderEvent {
  readonly sender: Contents;
  readonly senderFrame: Frame | null;
}
export function isTrustedSender(
  event: SenderEvent,
  expected: Contents,
  expectedUrl: string,
): boolean {
  if (
    event.sender !== expected ||
    !event.senderFrame ||
    event.senderFrame !== expected.mainFrame
  )
    return false;
  try {
    return new URL(event.senderFrame.url).href === new URL(expectedUrl).href;
  } catch {
    return false;
  }
}
