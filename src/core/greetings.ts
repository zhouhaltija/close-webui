const greetings = {
  morning: ['早上好，今天想探索什么？', '新的一天，从一个想法开始。', '让今天有个清晰的起点。'],
  daytime: ['从一个好问题开始。', '一起把想法往前推进。', '今天有什么值得探索？'],
  evening: ['晚上好，让灵感慢慢展开。', '今晚有什么新想法？', '给思考留一点时间。'],
  late: ['深夜即兴时刻。', '夜深了，灵感还醒着。', '安静的时候，想法更清晰。'],
};

export function getGreeting(date = new Date(), random = Math.random): string {
  const hour = date.getHours();
  const pool = hour >= 6 && hour < 12 ? greetings.morning : hour >= 12 && hour < 18 ? greetings.daytime : hour >= 18 && hour < 23 ? greetings.evening : greetings.late;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}
