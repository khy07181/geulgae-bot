// 길드 커맨드 등록: DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... DISCORD_GUILD_ID=... npm run register
const required = ["DISCORD_TOKEN", "DISCORD_APPLICATION_ID", "DISCORD_GUILD_ID"] as const;
for (const name of required) {
  if (!process.env[name]) {
    console.error(`환경변수 ${name}가 필요해요. 예: ${required.map((n) => `${n}=...`).join(" ")} npm run register`);
    process.exit(1);
  }
}

const STRING = 3;
const INTEGER = 4;
const USER = 6;

const commands = [
  {
    name: "목표설정",
    description: "이번 주(또는 다음 주) 글쓰기 목표를 설정해요",
    options: [
      { type: STRING, name: "참여자", description: "참여자 멘션 (예: @하영 @민희)", required: true },
      { type: INTEGER, name: "개수", description: "주당 목표 글 개수 (기본 1)", required: false, min_value: 1 },
      { type: INTEGER, name: "벌금", description: "미달 1개당 벌금, 원 (기본 10000)", required: false, min_value: 0 },
      {
        type: STRING, name: "주차", description: "어느 주의 목표인지 (기본: 이번주)", required: false,
        choices: [
          { name: "이번주", value: "이번주" },
          { name: "다음주", value: "다음주" },
        ],
      },
    ],
  },
  {
    name: "인증",
    description: "쓴 글 링크를 인증해요",
    options: [{ type: STRING, name: "링크", description: "https:// 로 시작하는 글 링크", required: true }],
  },
  { name: "현황", description: "이번 주 진행 현황을 봐요", options: [] },
  { name: "벌금현황", description: "누적 벌금 현황을 봐요", options: [] },
  {
    name: "벌금조정",
    description: "벌금을 수동으로 조정해요 (양수=부과, 음수=삭감)",
    options: [
      { type: USER, name: "대상", description: "조정할 멤버", required: true },
      { type: INTEGER, name: "금액", description: "원 단위, 양수=부과·음수=삭감", required: true },
      { type: STRING, name: "사유", description: "선택 사항", required: false },
    ],
  },
  {
    name: "참여취소",
    description: "이번 주 참여를 취소해요 (인증한 글이 없을 때만)",
    options: [{ type: USER, name: "대상", description: "취소할 멤버 (기본: 본인)", required: false }],
  },
];

const url = `https://discord.com/api/v10/applications/${process.env.DISCORD_APPLICATION_ID}/guilds/${process.env.DISCORD_GUILD_ID}/commands`;
const res = await fetch(url, {
  method: "PUT",
  headers: {
    authorization: `Bot ${process.env.DISCORD_TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(commands),
});
if (!res.ok) {
  console.error(`등록 실패: ${res.status}`, await res.text());
  process.exit(1);
}
console.log(`길드 커맨드 ${commands.length}개 등록 완료`);

export {};
