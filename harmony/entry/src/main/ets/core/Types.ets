export interface PairingPayload {
  protocol: string; version: number; name: string; url: string; platform?: string;
  token: string; certificate: string; publicKeyHash: string;
}
export interface PairedMac {
  actionScope?: string; name: string; url: string; session: string; certificate: string; publicKeyHash: string; platform?: string;
}
export interface ComputerSummary { id: string; name: string; platform: string; }
export interface ComputerProfile extends ComputerSummary { publicKeyHash: string; legacy?: boolean; }
export interface ComputerRegistry { version: number; activeId: string; computers: ComputerProfile[]; }
export interface BridgeItem {
  id: string; kind: string; source: string; createdAt: string;
  name?: string; text?: string; size?: number; sha256?: string; receivedAt?: string;
}
export interface Workflow { id: string; name: string; description: string; enabled: boolean; }
export interface Job { id: string; name: string; status: string; message: string; }
export interface Capabilities { reliableActions: number; }
export interface PendingAction { requestId: string; requestedAt: number; scope: string; kind: string; value: string; }
export interface BridgeState { platform?: string; capabilities?: Capabilities; revision?: string; name: string; items: BridgeItem[]; workflows: Workflow[]; jobs: Job[]; }
export interface StateDelta { baseRevision: string; state: BridgeState; removed: string[]; order?: string[]; }
export interface StateUpdate { revision: string; state?: BridgeState; delta?: StateDelta; }
export interface PairClaim { id: string; claim: string; }
export interface PairStatus { status: string; session?: string; }
export interface TransferReply { id: string; offset: number; size: number; chunkSize: number; item?: BridgeItem; }
export interface SavedFile { id: string; path: string; sha256: string; }
export interface SendJob { id: string; uri: string; name: string; size: number; modified: number; }
export interface ErrorReply { error?: string; }
export interface ShareRecord { uri: string; text: string; name: string; }
