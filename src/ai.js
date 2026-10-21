const DEFAULT_SYSTEM_PROMPT = `Bạn là trợ lý AI thông minh, vui vẻ, thân thiện của bot nhóm Facebook Messenger tiếng Việt.
Phong cách trò chuyện:
- Thân thiện, tự nhiên, gần gũi, hóm hỉnh.
- Trả lời bằng tiếng Việt gãy gọn, đúng trọng tâm, phù hợp với chat nhóm.
- Định dạng tin nhắn thoáng đãng, dễ đọc, có thể thêm emoji sinh động.
- Không trả lời quá dài lê thê trừ khi được yêu cầu làm thơ, viết văn hoặc giải thích sâu.`;

/**
 * Gọi Pollinations AI (Miễn phí 100%, không cần API key)
 */
async function askPollinations(prompt, options = {}) {
  const systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const messages = options.messages && options.messages.length > 0
    ? [{ role: 'system', content: systemPrompt }, ...options.messages]
    : [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch('https://text.pollinations.ai/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        model: 'openai',
        seed: Math.floor(Math.random() * 1000000)
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`Pollinations HTTP ${res.status}`);
    }

    const text = await res.text();
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gọi Google Gemini API nếu có GEMINI_API_KEY
 */
async function askGemini(prompt, apiKey, options = {}) {
  const systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const contents = options.messages && options.messages.length > 0
    ? options.messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }))
    : [{ role: 'user', parts: [{ text: prompt }] }];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  const candidateModels = [
    process.env.GEMINI_MODEL,
    options.model,
    'gemini-flash-lite-latest',
    'gemini-3.5-flash-lite',
    'gemini-flash-latest'
  ].filter(Boolean);

  try {
    for (const model of candidateModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify({
            contents,
            systemInstruction: {
              parts: [{ text: systemPrompt }]
            },
            generationConfig: {
              maxOutputTokens: 800,
              temperature: 0.7
            }
          }),
          signal: controller.signal
        });

        if (res.status === 404) {
          // Model không khả dụng, thử model tiếp theo trong danh sách
          continue;
        }

        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          throw new Error(`Gemini API ${res.status}: ${errBody.slice(0, 100)}`);
        }

        const data = await res.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (reply) return reply.trim();
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        // Tiếp tục thử model kế tiếp nếu có lỗi 404/not found
        if (/404|not found/i.test(err.message)) continue;
        throw err;
      }
    }
    throw new Error('Không có model Gemini nào phản hồi thành công');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gọi OpenAI / Groq / DeepSeek API nếu có API key
 */
async function askOpenAI(prompt, apiKey, options = {}) {
  const systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const messages = options.messages && options.messages.length > 0
    ? [{ role: 'system', content: systemPrompt }, ...options.messages]
    : [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const baseUrl = options.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const model = options.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 800,
        temperature: 0.7
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`OpenAI API ${res.status}`);
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content;
    if (!reply) throw new Error('OpenAI không trả về nội dung');
    return reply.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hàm gọi AI thông minh tự động đa tầng:
 * Ưu tiên: Gemini 3.5 Flash-Lite (siêu tốc <1s) -> Groq (siêu tốc ~300ms) -> OpenAI -> Fallback Pollinations
 */
async function askAI(prompt, options = {}) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (geminiKey) {
    try {
      return await askGemini(prompt, geminiKey, options);
    } catch (err) {
      console.warn('[AI] Gemini lỗi, chuyển sang fallback:', err.message);
    }
  }

  if (groqKey) {
    try {
      return await askOpenAI(prompt, groqKey, {
        ...options,
        baseUrl: 'https://api.groq.com/openai/v1',
        model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant'
      });
    } catch (err) {
      console.warn('[AI] Groq lỗi, chuyển sang fallback:', err.message);
    }
  }

  if (openaiKey) {
    try {
      return await askOpenAI(prompt, openaiKey, options);
    } catch (err) {
      console.warn('[AI] OpenAI lỗi, chuyển sang fallback:', err.message);
    }
  }

  return await askPollinations(prompt, options);
}

module.exports = {
  askAI,
  askPollinations,
  askGemini,
  askOpenAI,
  DEFAULT_SYSTEM_PROMPT
};
