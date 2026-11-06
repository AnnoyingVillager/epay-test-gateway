const { makeSign } = require('../src/epay');

const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const pid = process.env.MERCHANT_PID || '1001';
const key = process.env.MERCHANT_KEY || 'test-merchant-key-change-me';
const bindCard = process.env.BIND_CARD;
const outTradeNo = process.env.OUT_TRADE_NO || `DEMO-${Date.now()}`;
const money = process.env.MONEY || '10.00';
const notifyUrl = process.env.NOTIFY_URL || `${baseUrl}/merchant-notify`;
const returnUrl = process.env.RETURN_URL || `${baseUrl}/merchant-return`;

if (!bindCard) {
  console.error('BIND_CARD is required. Copy CARD-... from the admin card detail page.');
  console.error('Example: BIND_CARD=CARD-1234567890 npm run test:merchant');
  process.exit(1);
}

const params = {
  act: 'order',
  pid,
  type: process.env.PAY_TYPE || 'alipay',
  out_trade_no: outTradeNo,
  notify_url: notifyUrl,
  return_url: returnUrl,
  name: process.env.ORDER_NAME || 'Epay integration test order',
  money,
  sitename: process.env.SITE_NAME || 'Demo Shop',
  bind_card: bindCard,
  timeout: process.env.TIMEOUT || '900'
};
params.sign = makeSign(params, key);
params.sign_type = 'MD5';

const url = new URL('/api.php', baseUrl);
for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

fetch(url)
  .then(async (response) => {
    const body = await response.json();
    console.log(JSON.stringify({ requestUrl: url.toString(), response: body }, null, 2));
    if (body.payurl) {
      const target = body.payurl.startsWith('http') ? body.payurl : `${baseUrl}${body.payurl}`;
      console.log(`\nOpen payment page:\n${target}`);
    }
    if (!response.ok || body.code !== 1) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
