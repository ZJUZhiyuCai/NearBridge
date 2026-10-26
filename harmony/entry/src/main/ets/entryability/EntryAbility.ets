import { UIAbility, Want, AbilityConstant } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { BridgeClient } from '../core/BridgeClient';

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    BridgeClient.shared.init(this.context);
  }
  onWindowStageCreate(stage: window.WindowStage): void { stage.loadContent('pages/Index'); }
  onForeground(): void { BridgeClient.shared.start(); }
  onBackground(): void { BridgeClient.shared.stop(); }
  onDestroy(): void { BridgeClient.shared.stop(); }
}
