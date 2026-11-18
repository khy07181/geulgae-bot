-- PAGE-008·PAGE-011·PAGE-012: 결산 '관심 키워드'.
-- 글 본문은 저장하지 않고(PAGE-012), 추출된 키워드만 제출 단위로 남긴다.
CREATE TABLE keywords (
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  keyword TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (submission_id, keyword)
);
