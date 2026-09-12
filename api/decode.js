// api/decode.js
// 서버리스 함수: 클라이언트에서 받은 에러 로그를 Solar Pro 4 API로 분석
// 환경변수 UPSTAGE_API_KEY를 사용(클라이언트에는 절대 노출하지 않음)

const MODEL = process.env.MODEL || 'solar-pro';
const UPSTAGE_API_URL = process.env.UPSTAGE_API_URL || 'https://api.upstage.ai/v1/chat/completions';

function buildUserPrompt(log) {
  return `다음 에러 로그 / 스택 트레이스를 분석해 아래 형식으로 정리해줘.

## 출력 형식 (JSON)
{
  "card": {
    "type": "<오류 유형>",
    "location": "<발생 위치(파일:라인 / 함수 / 모듈)>",
    "severity": "<치명적|높음|중간|낮음>",
    "note": "<한 줄 설명(선택)>"
  },
  "guide": [
    {
      "title": "1단계 — 원인 분석",
      "body": "<원인 설명 2~4문장>",
      "blocks": []
    },
    {
      "title": "2단계 — 즉시 수정 (코드 / CLI)",
      "body": "<수정 방향 요약>",
      "blocks": [
        { "label": "수정 전 (코드)", "lang": "<언어>", "code": "<코드>" },
        { "label": "수정 후 (코드)", "lang": "<언어>", "code": "<코드>" }
      ]
    },
    {
      "title": "3단계 — 확인 방법",
      "body": "<확인 단계 1~3>",
      "blocks": []
    }
  ],
  "checklist": ["<재발 방지 항목 1>", "<재발 방지 항목 2>", "<재발 방지 항목 3>", "<모니터링/알럿>", "<테스트·검증 강화>"]
}

## 분석 규칙
- 가장 아래쪽 "Caused by" / 가장 깊은 프레임부터 역방향으로 읽어 근본 원인을 찾는다.
- "Caused by", "Suppressed", "Wrapped", "Original exception" 표시가 있으면 그 안쪽이 진짜 원인일 확률이 높다.
- 스택 프레임에서 파일명:라인, 함수명, 변수명을 추출해 수정 대상을 특정한다.
- 코드 수정 제안은 수정 전/후 스니펫을 함께 제시한다.
- 근본 원인을 단정할 수 없으면 "추정"임을 밝히고 가능한 원인 후보 2~3개를 함께 제시한다.
- 너무 장황하지 않게 핵심만 담는다.

## 에러 로그
${log}
`;
}

export async function POST(req) {
  // CORS: 같은 도메인에서만 호출되므로 기본 정책만 적용
  const allowedOrigin = new URL(req.url).origin;
  const headers = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST만 지원' }), {
      status: 405,
      headers: { ...headers, 'Content-Type': 'application/json' }
    });
  }

  // 환경변수 확인(값 노출은 금지)
  if (!process.env.UPSTAGE_API_KEY) {
    return new Response(JSON.stringify({ error: '서버 설정 누락: UPSTAGE_API_KEY가 필요합니다.' }), {
      status: 500,
      headers: { ...headers, 'Content-Type': 'application/json' }
    });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: '요청 본문이 JSON이 아닙니다.' }), {
      status: 400,
      headers: { ...headers, 'Content-Type': 'application/json' }
    });
  }

  const log = (body && body.log && String(body.log).trim()) || '';

  if (!log) {
    return new Response(JSON.stringify({
      card: { type: '', location: '', severity: '', note: '분석할 에러 로그를 붙여넣어 주세요. 빈 입력이라 분석할 내용이 없습니다.' },
      guide: [],
      checklist: []
    }), {
      status: 200,
      headers: { ...headers, 'Content-Type': 'application/json' }
    });
  }

  const userPrompt = buildUserPrompt(log);

  // Solar Pro 4 API 호출
  const response = await fetch(UPSTAGE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.UPSTAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are a helpful error-analysis assistant. Respond with valid JSON only using the format specified above. Do not include any text outside the JSON object.' },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      max_tokens: 1600,
      response_format: { type: 'json_object' }
    }),
  });

  if (!response.ok) {
    return new Response(JSON.stringify({ error: 'Solar Pro 4 API 호출 실패: ' + response.status }), {
      status: 502,
      headers: { ...headers, 'Content-Type': 'application/json' }
    });
  }

  const raw = await response.json();

  // 모델 응답에서 JSON 추출
  let content = '';
  if (raw && raw.choices && raw.choices.length > 0) {
    const msg = raw.choices[0].message;
    content = msg && msg.content ? msg.content : '';
  }

  let parsed;
  if (!content) {
    parsed = { card: { type: '분석 실패', location: '', severity: '높음', note: '모델 응답이 비어 있습니다. 다시 시도해 주세요.' }, guide: [], checklist: [] };
  } else {
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      // JSON 파싱 실패 시 텍스트 응답에서 최소한의 카드 추출 시도
      parsed = {
        card: { type: '분석 결과(포맷 오류)', location: '', severity: '높음', note: '모델 응답이 예상 JSON 형식이 아닙니다. 로그 원문을 다시 확인해 주세요.' },
        guide: [],
        checklist: []
      };
    }
  }

  // 응답에 키가 섞여 있지 않은지 최종 점검(서버 측)
  if (parsed && typeof parsed === 'object') {
    // UPSTAGE_API_KEY 같은 값이 실수로 포함되지 않았는지 확인
    const jsonStr = JSON.stringify(parsed);
    if (jsonStr.includes(process.env.UPSTAGE_API_KEY)) {
      console.error('응답 JSON에 UPSTAGE_API_KEY가 포함되어 있습니다. 서버 로그를 확인하세요.');
    }
  }

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json' }
  });
}
