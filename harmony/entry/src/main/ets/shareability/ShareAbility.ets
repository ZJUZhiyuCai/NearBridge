import { ShareExtensionAbility, Want, UIExtensionContentSession } from '@kit.AbilityKit';
import { systemShare } from '@kit.ShareKit';
import { BridgeClient } from '../core/BridgeClient';
import { ShareRecord } from '../core/Types';

export default class ShareAbility extends ShareExtensionAbility {
  onSessionCreate(want: Want, session: UIExtensionContentSession): void {
    BridgeClient.shared.init(this.context);
    BridgeClient.shared.syncComputerSelection();
    const storage = new LocalStorage();
    storage.setOrCreate('shareJSON', '[]');
    storage.setOrCreate('shareError', '');
    session.loadContent('pages/SharePage', storage);
    systemShare.getSharedData(want).then((data: systemShare.SharedData) => {
      const records: ShareRecord[] = data.getRecords().map((record: systemShare.SharedRecord): ShareRecord => {
        const uri = record.uri || '';
        const text = record.content || (/^https?:\/\//i.test(uri) ? uri : '');
        return { uri: uri, text: text, name: record.title || '' };
      });
      storage.setOrCreate('shareJSON', JSON.stringify(records));
    }).catch((error: Error) => { storage.setOrCreate('shareError', error.message); });
  }
  onSessionDestroy(_session: UIExtensionContentSession): void { BridgeClient.shared.pauseSending(); }
}
