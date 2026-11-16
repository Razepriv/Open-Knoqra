import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import type { Message } from '../../lib/inbox';

/** What the thread hands the composer: the message being replied to, and files dropped on it. */
interface Bridge {
  replyTo: Message | null;
  setReplyTo: (message: Message | null) => void;
  dropped: File | null;
  setDropped: (file: File | null) => void;
}

const BridgeContext = createContext<Bridge | null>(null);

export function ComposerBridge({ children }: { children: ReactNode }) {
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [dropped, setDropped] = useState<File | null>(null);
  const value = useMemo(() => ({ replyTo, setReplyTo, dropped, setDropped }), [replyTo, dropped]);
  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}

const NONE: Bridge = {
  replyTo: null,
  setReplyTo: () => undefined,
  dropped: null,
  setDropped: () => undefined,
};

/** The bridge, or a no-op one outside a thread (a composer rendered alone in a test). */
export function useComposerBridge(): Bridge {
  return useContext(BridgeContext) ?? NONE;
}
