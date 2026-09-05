// Item 6. Our AGENT image (alpine + chromium) under Firecracker: headless Chromium answers
// CDP `/json/version`. Needs ENGINE_VERCEL_AGENT_IMAGE, pushed by item 13.
import { AGENT_IMAGE, create, sh, verdict, record, done, stopQuietly } from './lib.js';

if (!AGENT_IMAGE) {
  console.error('SKIP  6  set ENGINE_VERCEL_AGENT_IMAGE to the agent image pushed by 13-push-images.sh');
  process.exit(2);
}
const sandbox = await create({ image: AGENT_IMAGE, networkPolicy: 'deny-all' });
try {
  const bin = await sh(sandbox, 'echo ${ENGINE_CHROMIUM:-/usr/bin/chromium-browser}; ls -la ${ENGINE_CHROMIUM:-/usr/bin/chromium-browser}');
  record('6', bin.out.replace(/\n/g, ' | '));
  await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', '${ENGINE_CHROMIUM:-/usr/bin/chromium-browser} --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --remote-debugging-port=9222 about:blank > /tmp/chromium.log 2>&1'],
    detached: true,
  });
  let version = '';
  for (let i = 0; i < 40 && !version; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const probe = await sh(sandbox, `node -e "fetch('http://127.0.0.1:9222/json/version').then(r=>r.json()).then(j=>console.log(j.Browser),()=>process.exit(1))"`);
    if (probe.code === 0) version = probe.out;
  }
  verdict('6.cdp', version !== '', version || (await sh(sandbox, 'tail -n 5 /tmp/chromium.log')).out);
} finally {
  await stopQuietly(sandbox);
}
done();
