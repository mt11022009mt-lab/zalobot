const DEFAULT_SYSTEM_PROMPT = `Bạn là trợ lý AI thông minh, vui vẻ, thân thiện của bot nhóm Facebook Messenger tiếng Việt.
Phong cách trò chuyện:
- Thân thiện, tự nhiên, gần gũi, hóm hỉnh.
- Trả lời bằng tiếng Việt gãy gọn, đúng trọng tâm, phù hợp với chat nhóm.
- Định dạng tin nhắn thoáng đãng, dễ đọc, có thể thêm emoji sinh động.
- Không trả lời quá dài lê thê trừ khi được yêu cầu làm thơ, viết văn hoặc giải thích sâu.`;

/**
 * Gọi Pollinations AI (Miễn phí 100%, không cần API key)
 */
async function askPollinations(prompt, systemPrompt = DEFAULT_SYSTEM_PROMPT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch('https://text.pollinations.ai/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
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
async function askGemini(prompt, apiKey, systemPrompt = DEFAULT_SYSTEM_PROMPT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: prompt }] }
        ],
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        generationConfig: {
          maxOutputTokens: 1000,
          temperature: 0.7
        }
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Gemini API ${res.status}: ${errBody.slice(0, 100)}`);
    }

    const data = await res.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) throw new Error('Gemini không trả về nội dung');
    return reply.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gọi OpenAI / Groq / DeepSeek API nếu có OPENAI_API_KEY
 */
async function askOpenAI(prompt, apiKey, systemPrompt = DEFAULT_SYSTEM_PROMPT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        max_tokens: 1000,
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
 * Hàm gọi AI thông minh tự động:
 * Ưu tiên: Gemini -> OpenAI -> Fallback Pollinations miễn phí
 */
async function askAI(prompt, options = {}) {
  const systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (geminiKey) {
    try {
      return await askGemini(prompt, geminiKey, systemPrompt);
    } catch (err) {
      console.warn('[AI] Gemini lỗi, chuyển sang fallback:', err.message);
    }
  }

  if (openaiKey) {
    try {
      return await askOpenAI(prompt, openaiKey, systemPrompt);
    } catch (err) {
      console.warn('[AI] OpenAI lỗi, chuyển sang fallback:', err.message);
    }
  }

  return await askPollinations(prompt, systemPrompt);
}

module.exports = {
  askAI,
  askPollinations,
  askGemini,
  askOpenAI,
  DEFAULT_SYSTEM_PROMPT
};
