import cheerio from 'cheerio';

export const config = {
  api: {
    bodyParser: false,
    responseLimit: '10mb',
  },
};

// Timeout helper — ৮ সেকেন্ডের বেশি রেসপন্স আসলে ব্রেক
function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timeout after ' + ms + 'ms')), ms)
    ),
  ]);
}

// Phone number normalize করা — +880, 880, 01 সব format handle করে
function normalizePhone(raw) {
  let digits = raw.replace(/[^0-9]/g, '');
  if (digits.startsWith('880') && digits.length === 13) {
    digits = '0' + digits.substring(3);
  }
  return digits;
}

// Common browser headers — যাতে বট হিসেবে block না হয়
function getHeaders(extra = {}) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    ...extra,
  };
}

// OPTIONS request handle — CORS preflight
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Only GET method allowed' });
  }

  const rawPhone = req.query.phone;
  if (!rawPhone) {
    return res.status(400).json({
      success: false,
      error: 'Phone number required. Usage: /api/check?phone=017XXXXXXXX',
    });
  }

  const phone = normalizePhone(rawPhone);
  if (phone.length < 11 || phone.length > 11) {
    return res.status(400).json({
      success: false,
      error: 'Invalid BD phone number. Must be 11 digits (01XXXXXXXXX)',
      normalized: phone,
    });
  }

  const BASE = 'https://www.fraudcheckerbd.online';

  try {
    // ====== STEP 1: পেজটা GET করে form structure বোঝা ======
    const initRes = await withTimeout(
      fetch(BASE, {
        method: 'GET',
        headers: getHeaders(),
        redirect: 'follow',
      })
    );

    const initHtml = await initRes.text();
    const $init = cheerio.load(initHtml);

    // Form action বের করা
    const form = $init('form').first();
    let formAction = form.attr('action') || '';
    let formMethod = (form.attr('method') || 'POST').toUpperCase();

    // Full URL বানানো
    if (formAction && !formAction.startsWith('http')) {
      formAction = formAction.startsWith('/')
        ? BASE + formAction
        : BASE + '/' + formAction;
    }
    if (!formAction) formAction = BASE;

    // Phone input field এর name attribute বের করা
    let phoneField = 'phone';
    const inputSelectors = [
      'input[type="tel"]',
      'input[type="number"]',
      'input[name*="phone"]',
      'input[name*="mobile"]',
      'input[name*="number"]',
      'input[name*="search"]',
      'input[name*="q"]',
    ];
    for (const sel of inputSelectors) {
      const el = $init(sel).first();
      if (el.length) {
        phoneField = el.attr('name') || 'phone';
        break;
      }
    }

    // CSRF token / hidden inputs বের করা
    const hiddenFields = {};
    $init('form input[type="hidden"]').each((_, el) => {
      const name = $init(el).attr('name');
      const value = $init(el).attr('value') || '';
      if (name) hiddenFields[name] = value;
    });

    // CSRF token আলাদা চেক
    const csrfSelectors =
      'input[name*="csrf"], input[name*="_token"], input[name*="token"], input[name*="csrf_token"]';
    $init(csrfSelectors).each((_, el) => {
      const name = $init(el).attr('name');
      const value = $init(el).attr('value') || '';
      if (name && value) hiddenFields[name] = value;
    });

    // Form data তৈরি
    const formData = new URLSearchParams();
    formData.append(phoneField, phone);
    for (const [key, val] of Object.entries(hiddenFields)) {
      if (key !== phoneField) formData.append(key, val);
    }

    // ====== STEP 2: Form submit করা ======
    let resultHtml = '';
    const cookieHeader = initRes.headers.get('set-cookie') || '';

    if (formMethod === 'POST') {
      const postRes = await withTimeout(
        fetch(formAction, {
          method: 'POST',
          headers: getHeaders({
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: BASE,
            Referer: BASE + '/',
            Cookie: cookieHeader,
          }),
          body: formData.toString(),
          redirect: 'follow',
        })
      );
      resultHtml = await postRes.text();
    } else {
      const qs = formData.toString();
      const getRes = await withTimeout(
        fetch(`${formAction}?${qs}`, {
          method: 'GET',
          headers: getHeaders({ Referer: BASE + '/' }),
          redirect: 'follow',
        })
      );
      resultHtml = await getRes.text();
    }

    // ====== STEP 3: Response HTML parse করে data extract করা ======
    const $ = cheerio.load(resultHtml);

    const output = {
      success: true,
      phone: phone,
      checked_at: new Date().toISOString(),
      source: 'fraudcheckerbd.online',
      status: null,
      status_label: null,
      complaint_count: null,
      details: [],
      tables: [],
      alerts: [],
    };

    // --- Tables extract ---
    $('table').each((_, table) => {
      const rows = [];
      $(table)
        .find('tr')
        .each((_, tr) => {
          const cells = [];
          $(tr)
            .find('th, td')
            .each((_, cell) => {
              cells.push($(cell).text().trim());
            });
          if (cells.some((c) => c.length > 0)) rows.push(cells);
        });
      if (rows.length > 0) output.tables.push(rows);
    });

    // --- Alerts / messages extract ---
    const alertSelectors = [
      '.alert',
      '[role="alert"]',
      '.toast',
      '.message',
      '.notice',
      '.alert-success',
      '.alert-danger',
      '.alert-warning',
      '.alert-info',
      '.flash',
      '.notification',
      '.result-message',
      '.status-message',
      '.error',
      '.success',
      '.warning',
    ];
    $(alertSelectors.join(', ')).each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 0) {
        const cls = $(el).attr('class') || '';
        let type = 'info';
        if (/success|safe|green|নিরাপদ/.test(cls + ' ' + text.toLowerCase()))
          type = 'success';
        else if (/danger|error|fraud|red|ফ্রড|অপরাধ/.test(cls + ' ' + text.toLowerCase()))
          type = 'danger';
        else if (/warning|suspicious|yellow|সন্দেহজনক/.test(cls + ' ' + text.toLowerCase()))
          type = 'warning';
        output.alerts.push({ type, text });
      }
    });

    // --- Result sections extract ---
    const resultSelectors = [
      '.result',
      '.results',
      '.search-result',
      '.search-results',
      '.report',
      '.report-details',
      '.detail',
      '.details',
      '.info',
      '.card-body',
      '.response',
      '.output',
      '.check-result',
      '.fraud-result',
      '.result-box',
    ];
    $(resultSelectors.join(', ')).each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 5 && text.length < 5000) {
        output.details.push(text);
      }
    });

    // --- Status detect করা (page text থেকে) ---
    const bodyText = $('body').text();
    const lowerText = bodyText.toLowerCase();

    if (/fraud|ফ্রড|অপরাধী|প্রতারণা|scammer|scam/.test(lowerText)) {
      output.status = 'FRAUD';
      output.status_label = 'ফ্রড / প্রতারক';
    } else if (/safe|নিরাপদ|ভালো|clean|trusted|বিশ্বস্ত/.test(lowerText)) {
      output.status = 'SAFE';
      output.status_label = 'নিরাপদ';
    } else if (/suspicious|সন্দেহজনক|risk|ঝুঁকিপূর্ণ/.test(lowerText)) {
      output.status = 'SUSPICIOUS';
      output.status_label = 'সন্দেহজনক';
    } else if (/not found|পাওয়া যায়নি|no result|কোনো তথ্য নেই/.test(lowerText)) {
      output.status = 'NOT_FOUND';
      output.status_label = 'কোনো তথ্য পাওয়া যায়নি';
    }

    // --- Complaint count ---
    const complaintPatterns =
      /(\d+)\s*(complaint|রিপোর্ট|অভিযোগ|report|টি রিপোর্ট|টি অভিযোগ)/gi;
    const match = complaintPatterns.exec(lowerText);
    if (match) {
      output.complaint_count = parseInt(match[1], 10);
    }

    // --- Tables থেকে status আবার চেক ---
    if (!output.status && output.tables.length > 0) {
      const tableText = output.tables.map((t) => t.flat().join(' ')).join(' ').toLowerCase();
      if (/fraud|ফ্রড|প্রতারণা/.test(tableText)) {
        output.status = 'FRAUD';
        output.status_label = 'ফ্রড / প্রতারক';
      } else if (/safe|নিরাপদ/.test(tableText)) {
        output.status = 'SAFE';
        output.status_label = 'নিরাপদ';
      }
    }

    // --- যদি structured data না পাওয়া যায় ---
    const hasStructuredData =
      output.tables.length > 0 ||
      output.details.length > 0 ||
      output.alerts.length > 0;

    if (!hasStructuredData) {
      // Main content area থেকে text নেওয়ার চেষ্টা
      const contentAreas = ['main', '.content', '#content', '.container', '.main-content', 'article'];
      for (const sel of contentAreas) {
        const text = $(sel).text().trim();
        if (text.length > 30) {
          output.raw_content = text.substring(0, 5000);
          break;
        }
      }
      if (!output.raw_content) {
        output.raw_content = bodyText.substring(0, 5000);
      }
      output.extraction_note =
        'Structured data extract করা যায়নি। Raw content দেওয়া হলো।';
    }

    // --- চেক: কি আগের মতোই search page আছে? (JS rendering হলে এটা হতে পারে) ---
    const stillOnSearch =
      $('input[type="tel"], input[type="number"], input[name*="phone"]').length > 0 &&
      !hasStructuredData;

    if (stillOnSearch && !output.raw_content?.includes('ফ্রড') && !output.raw_content?.includes('fraud')) {
      output.status = 'NO_RESULT';
      output.status_label = 'রেজাল্ট লোড হয়নি (সাইটে JS rendering থাকতে পারে)';
      output.note =
        'ওয়েবসাইটে সম্ভবত JavaScript দিয়ে results দেখায়, যেটা server-side fetch দিয়ে capture করা সম্ভব না। Puppeteer/Playwright লাগতে পারে।';
    }

    // Response headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json(output);
  } catch (err) {
    console.error('FraudChecker Error:', err.message);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({
      success: false,
      phone: phone,
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
}
