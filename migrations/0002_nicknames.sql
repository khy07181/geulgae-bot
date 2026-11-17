-- PAGE-002: 홈페이지 작성자 표기용 닉네임. 본인이 /닉네임으로 등록·변경한다 (BOT-002).
CREATE TABLE nicknames (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL              -- UTC ISO 8601
);
