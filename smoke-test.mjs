import { LocalJev } from './src/jev.js';

const jev = await LocalJev.create();
console.log('device:', jev.device);

const out = await jev.ask(
  '客户留言：你们这个月账单多收了我200块钱，我已经打了三次电话了！再不解决我就投诉然后销号！',
  {
    want_fix: { type: 'noul', statement: '客户正在要求退款或纠正账单' },
    team: {
      type: 'choice',
      options: {
        billing: '账单和费用问题',
        tech: '技术故障或产品使用问题',
        sales: '销售、套餐和业务咨询',
      },
    },
    anger: { type: 'score', levels: ['完全不生气', '有点不满', '很生气', '极其愤怒'] },
  },
);
console.log(JSON.stringify(out, null, 2));
await jev.release();
console.log('OK');
