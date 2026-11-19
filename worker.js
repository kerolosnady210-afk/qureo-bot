export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/run' && request.method === 'POST') {
      const { studentId, password, course, geminiKey } = await request.json();

      const stream = new ReadableStream({
        async start(controller) {
          const sendLog = (msg) => controller.enqueue(new TextEncoder().encode(msg + "\n"));

          try {
            const session = new QureoBot(studentId, password, course, geminiKey, sendLog);
            await session.login();
            await session.runCourse();
            sendLog("🎉 تم الانتهاء من الكورس بنجاح!");
          } catch (error) {
            sendLog(`❌ خطأ: ${error.message}`);
          } finally {
            controller.close();
          }
        }
      });

      return new Response(stream, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked' }
      });
    }

    return new Response(HTML_CONTENT, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

class QureoBot {
  constructor(studentId, password, course, geminiKey, log) {
    this.studentId = studentId;
    this.password = password;
    this.course = course;
    this.geminiKey = geminiKey;
    this.log = log;
    this.cookies = "";
    this.baseUrl = "https://me-tp.qureo.education";
    this.portalUrl = "https://me-portal.qureo.education";
  }

  async req(url, options = {}) {
    options.headers = options.headers || {};
    if (this.cookies) options.headers['Cookie'] = this.cookies;
    if (options.body) options.headers['Content-Type'] = 'application/json';
    
    const res = await fetch(url, options);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      this.cookies = setCookie.split(',').map(c => c.split(';')[0]).join('; ');
    }
    return res;
  }

  async login() {
    this.log("🔑 جاري تسجيل الدخول...");
    const res = await this.req(`${this.portalUrl}/oauth2/password-login`, {
      method: 'POST',
      body: JSON.stringify({ student_id: this.studentId, password: this.password })
    });
    if (res.status !== 200 && res.status !== 204) {
      throw new Error("فشل تسجيل الدخول. تأكد من البيانات.");
    }
    this.log("✅ تم تسجيل الدخول بنجاح.");
  }

  async getLectureContent(lid, cid) {
    const res = await this.req(`${this.baseUrl}/api/study/lectures/${lid}`, {
      headers: { 'Referer': `${this.baseUrl}/chapter/${cid}/lecture/${lid}` }
    });
    return await res.json();
  }

  async answerTalk(talkId, payload, cid, lid) {
    const res = await this.req(`${this.baseUrl}/api/study/students/lecture-talks/${talkId}`, {
      method: 'PUT',
      headers: { 'Referer': `${this.baseUrl}/chapter/${cid}/lecture/${lid}` },
      body: JSON.stringify({ value: payload })
    });
    return res.status === 200 || res.status === 204;
  }

  async solveWithAI(question, type, lang = "javascript") {
    let prompt = "";
    if (type === "choice_question") {
      prompt = `أنت خبير في لغة ${lang}. أجب عن سؤال الاختيار من متعدد التالي بالرقم فقط (1، 2، 3...). السؤال: "${question}"`;
    } else {
      prompt = `أنت مبرمج خبير في لغة ${lang}. اكتب الكود المطلوب فقط لحل هذا السؤال بدون أي شرح أو علامات ماركداون (\`\`\`). السؤال: "${question}"`;
    }

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': this.geminiKey
      },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    
    const data = await res.json();
    if(!data.candidates || !data.candidates[0]) throw new Error("خطأ في الذكاء الاصطناعي، تأكد من المفتاح.");
    
    let answer = data.candidates[0].content.parts[0].text.trim();
    if (type !== "choice_question") {
      answer = answer.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
    }
    return answer;
  }

  async runCourse() {
    this.log("📚 جاري البحث عن الفصول...");
    for (let chapterId = 90001; chapterId <= 90010; chapterId++) { 
      this.log(`\n📖 الفصل: ${chapterId}`);
      const lecsRes = await this.req(`${this.baseUrl}/api/study/students/chapters/${chapterId}/lectures`);
      if (lecsRes.status !== 200) {
        this.log("⚠️ الفصل ده مش متاح.");
        continue;
      }
      const lectures = await lecsRes.json();
      
      for (let lec of lectures) {
        const lid = lec.id;
        this.log(`  ▶️ الدرس: ${lid}`);
        
        await this.req(`${this.baseUrl}/api/study/students/lectures/${lid}`, { method: 'PUT' });
        const content = await this.getLectureContent(lid, chapterId);
        
        if (content && content.talks) {
          for (let talk of content.talks) {
            if (["choice_question", "try"].includes(talk.type)) {
              const questionText = talk.body.question || "";
              this.log(`    🤖 الذكاء الاصطناعي يفكر...`);
              
              const aiAnswer = await this.solveWithAI(questionText, talk.type);
              let payload;
              
              if (talk.type === "choice_question") {
                const choice = talk.body.choices.find(c => c.value == aiAnswer || c.label.includes(aiAnswer));
                payload = { choice_question: { value: choice ? choice.value : talk.body.choices[0].value } };
              } else {
                payload = { try: { lang: "javascript", answer: aiAnswer } };
              }
              
              await this.answerTalk(talk.id, payload, chapterId, lid);
              this.log(`    ✅ تم الإجابة.`);
            }
          }
        }
        
        await this.req(`${this.baseUrl}/api/study/students/lectures/${lid}/complete`, { method: 'PUT' });
        this.log(`  ✔️ الدرس مكتمل.`);
      }
    }
  }
}

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>بوت كوريو الذكي</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0f172a; color: #fff; }
    </style>
</head>
<body class="flex items-center justify-center min-h-screen p-4">
    <div class="bg-slate-800 p-8 rounded-2xl shadow-2xl w-full max-w-md border border-slate-700">
        <h1 class="text-3xl font-bold text-center mb-6 text-blue-400">بوت كوريو الذكي 🤖</h1>
        
        <div class="space-y-4">
            <div>
                <label class="block text-sm font-medium mb-1">Student ID</label>
                <input type="text" id="studentId" class="w-full p-3 rounded-lg bg-slate-900 border border-slate-600 focus:outline-none focus:border-blue-500" placeholder="أدخل رقم الطالب">
            </div>
            <div>
                <label class="block text-sm font-medium mb-1">Password</label>
                <input type="password" id="password" class="w-full p-3 rounded-lg bg-slate-900 border border-slate-600 focus:outline-none focus:border-blue-500" placeholder="أدخل كلمة المرور">
            </div>
            <div>
                <label class="block text-sm font-medium mb-1">مسار التعلم</label>
                <select id="course" class="w-full p-3 rounded-lg bg-slate-900 border border-slate-600 focus:outline-none focus:border-blue-500">
                    <option value="javascript_ar">JavaScript (جافاسكريبت)</option>
                    <option value="python_short_ar">Python (بايثون)</option>
                </select>
            </div>
            <div>
                <label class="block text-sm font-medium mb-1">مفتاح Gemini API</label>
                <input type="password" id="geminiKey" class="w-full p-3 rounded-lg bg-slate-900 border border-slate-600 focus:outline-none focus:border-blue-500" placeholder="AIza...">
            </div>
            
            <button onclick="startBot()" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded-lg transition duration-200 mt-4" id="startBtn">
                ابدأ الحل الآن 🚀
            </button>
        </div>

        <div id="logs" class="mt-6 h-64 overflow-y-auto bg-slate-900 p-4 rounded-lg text-sm font-mono text-green-400 hidden border border-slate-700"></div>
    </div>

    <script>
        async function startBot() {
            const studentId = document.getElementById('studentId').value;
            const password = document.getElementById('password').value;
            const course = document.getElementById('course').value;
            const geminiKey = document.getElementById('geminiKey').value;
            const logsDiv = document.getElementById('logs');
            const btn = document.getElementById('startBtn');

            if (!studentId || !password || !geminiKey) {
                alert('يا ريت تكمل كل البيانات الأول!');
                return;
            }

            btn.disabled = true;
            btn.innerHTML = 'جاري الحل... ⏳';
            logsDiv.classList.remove('hidden');
            logsDiv.innerHTML = 'بدأنا الشغل...<br>';

            try {
                const response = await fetch('/api/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ studentId, password, course, geminiKey })
                });

                const reader = response.body.getReader();
                const decoder = new TextDecoder();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const text = decoder.decode(value);
                    logsDiv.innerHTML += text + '<br>';
                    logsDiv.scrollTop = logsDiv.scrollHeight;
                }
            } catch (e) {
                logsDiv.innerHTML += '<span class="text-red-500">حدث خطأ: ' + e.message + '</span>';
            } finally {
                btn.disabled = false;
                btn.innerHTML = 'ابدأ الحل الآن 🚀';
            }
        }
    </script>
</body>
</html>`;
