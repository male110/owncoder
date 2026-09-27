const https = require('https');
const req = https.get('https://github.com', { timeout: 15000 }, res => {
  console.log('[build] TLS 连接成功，状态码: ' + res.statusCode);
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('error', e => {
  console.error('[build] TLS 连接失败: ' + e.message);
  if (e.message.includes('unable to verify') || e.message.includes('certificate')) {
    console.error('');
    console.error('========================================');
    console.error('  TLS 证书验证失败！');
    console.error('  可能原因：企业代理或自签 CA 未被信任');
    console.error('');
    console.error('  解决方案（按优先级）：');
    console.error('  1. 确保 NODE_OPTIONS 包含 --use-system-ca');
    console.error('  2. 设置 NODE_EXTRA_CA_CERTS 指向 CA 文件：');
    console.error('      = "C:\path\to\ca-bundle.crt"');
    console.error('  3. 联系 IT 部门获取正确的根 CA 文件');
    console.error('========================================');
  }
  process.exit(2);
});
req.on('timeout', () => {
  req.destroy();
  console.error('[build] TLS 连接超时（15秒）');
  process.exit(3);
});
