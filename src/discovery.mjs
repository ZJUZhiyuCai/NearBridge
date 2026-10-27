import Bonjour from 'bonjour-service';
import { VERSION } from './version.mjs';

export function publishDiscovery(name, port, onError = console.error) {
  const bonjour = new Bonjour({}, error => onError(`局域网发现不可用：${error.message}`));
  const service = bonjour.publish({ name, host: `${name.replace(/\.local$/i, '')}.local`, type: 'nearbridge', protocol: 'tcp', port,
    disableIPv6: true, txt: { version: VERSION } });
  service.on('error', error => onError(`局域网广播失败：${error.message}`));
  return () => new Promise(resolve => {
    bonjour.unpublishAll(() => bonjour.destroy(resolve));
  });
}
