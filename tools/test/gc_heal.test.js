// 伺服器：已發券的抽獎券訂單被改回「備貨中」→ 觸發器自動改回完成（不需要 Firebase）
const path = require('path'); const ups = [];
const db = { doc: p => ({ update: async d => ups.push([p, d]), get: async () => ({ exists: false }), set: async () => {} }), collection: () => ({ where: () => ({ where: () => ({ get: async () => ({ docs: [] }) }), get: async () => ({ docs: [] }) }), get: async () => ({ docs: [] }) }), runTransaction: async f => f({ get: async () => ({ exists: false }), set() {}, update() {} }) };
const fx = (o, f) => f || o;
const G = require(path.join(__dirname, '../../push/gacha.js'))({ db, push: async () => {}, displayName: async () => '', logger: console, ordAct: async () => {}, nt: n => '$' + n, onDocumentCreated: fx, onDocumentWritten: fx, onSchedule: fx, HOT: {} });
const ev = (b, a) => ({ data: { before: { exists: !!b, data: () => b }, after: { exists: !!a, data: () => a } }, params: { shop: 'S1', oid: 'o1' } });
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? '✓' : '✗', m); };
(async () => {
  await G.gachaOrder(ev({ src: 'gacha', status: 'done', granted: true }, { src: 'gacha', status: 'preparing', granted: true, buyer: 'B' }));
  ok(ups.some(([p, d]) => p === 'shops/S1/orders/o1' && d.status === 'done'), '已發券又被改成備貨中 → 自動改回完成');
  ups.length = 0; await G.gachaOrder(ev({ src: 'gacha', status: 'done', granted: true, later: true }, { src: 'gacha', status: 'confirmed', granted: true, later: true }));
  ok(!ups.length, '先抽再付還沒付款的不會被誤改');
  ups.length = 0; await G.gachaOrder(ev(null, { src: 'plant', status: 'preparing' }));
  ok(!ups.length, '一般訂單不受影響');
  console.log(pass + '/' + (pass + fail)); process.exit(fail ? 1 : 0);
})();
