import { clone } from '@bufbuild/protobuf';
import { ForwardMsgSchema, type ForwardMsg } from '@/gen/am/v1/event_pb';
import type { Session } from './session';

export interface ForwardTransfer {
  clientMsgId: string;
  uploads: Map<string, bigint>;
  snapshot?: ForwardMsg;
  ready?: ForwardMsg;
}

/** Copy through the two authenticated sessions. Reuse the completed snapshot,
 * uploaded attachments and message id when an acknowledgement is lost. */
export async function forwardAcrossServers(
  source: Session, destination: Session, sourceConvId: string, destinationConvId: string,
  eventIds: string[], transfer: ForwardTransfer, progress: (text: string) => void,
) {
  progress('正在读取原服务器的聊天记录…');
  transfer.snapshot ??= await source.exportForwardSnapshot(sourceConvId, eventIds);
  if (!transfer.ready) {
    const snapshot = clone(ForwardMsgSchema, transfer.snapshot);
    const media = new Set(snapshot.entries.flatMap((entry) => entry.body.case === 'image' || entry.body.case === 'file' ? [entry.body.value.mediaId.toString()] : []));
    const copied = new Set<string>();
    for (const entry of snapshot.entries) {
      entry.sourceServer ||= source.record.endpoint.address;
      entry.imported = true;
      if (entry.body.case !== 'image' && entry.body.case !== 'file') continue;
      const body = entry.body.value;
      const originalId = body.mediaId.toString();
      const key = JSON.stringify([source.record.id, destination.record.id, originalId]);
      let uploadedId = transfer.uploads.get(key);
      if (uploadedId === undefined) {
        progress(`正在复制附件 ${copied.size + 1}/${media.size}…`);
        const bytes = await source.t.mediaBytes(`/api/v1/media/${originalId}`);
        const name = entry.body.case === 'file' ? entry.body.value.name : `forwarded-image-${originalId}`;
        const uploaded = await destination.upload(new File([bytes], name, { type: bytes.type || 'application/octet-stream' }));
        uploadedId = uploaded.id;
        transfer.uploads.set(key, uploadedId);
      }
      body.mediaId = uploadedId;
      copied.add(originalId);
    }
    transfer.ready = snapshot;
  }
  progress('正在发送聊天记录…');
  await destination.importForwardSnapshot(destinationConvId, source.record.endpoint.address, transfer.ready, transfer.clientMsgId);
}
