// Which language is this text in? Used for subtitle files that do not say it ("1.vtt") and to tell a character encoding from its
// wrong readings. Two kinds of evidence, no site rules and no network: the script of the letters (Greek, Hebrew, Hangul...) and,
// where one script serves several languages, the share of very common words plus a few letters that belong to one language.
// Not sure = null: a wrong language is never guessed.
const words = list => list.split(/\s+/).filter(Boolean);
const STOPWORDS = {
  tr: words('bir bu ve ne için ben sen değil çok var yok evet hayır gibi ama daha mi mı mu mü ya da de da ki şu o ne nasıl neden şimdi tamam lütfen bana sana bunu şunu olarak ise onu benim senin biz siz onlar çünkü artık hiç her kadar sonra önce burada orada'),
  en: words("the you and to is it that of in what was he for this are with have not but they his she her we me my your on be do at as can will just if so there no yes know like get go oh i'm don't it's you're that's"),
  de: words('der die das und ist nicht ich du sie er es wir ihr ein eine zu mit auf für den dem von was wie aber auch noch nur ja nein doch kann wird sind war haben hat'),
  fr: words('le la les des un une et est que qui pas je tu il elle nous vous ils pour dans sur avec ce cette mais ou où ne se de du au aux plus très oui non suis es sont'),
  es: words('el la los las un una y es que no yo tú él ella nosotros por para con en de del al lo se su mi pero como más muy sí qué está son soy eres'),
  it: words('il lo la gli le un una e è che non io tu lui lei noi voi loro per con di del della in su ma come più molto sì no sono sei siamo questo questa'),
  pt: words('o a os as um uma e é que não eu tu ele ela nós vocês eles para com em de do da no na mas como mais muito sim está são sou você'),
  nl: words('de het een en van ik je dat is niet op te in met voor zijn dit ze maar ook wat er hij ja nee dan nog wel naar aan als bij om hebben heb hebt ben bent wij jij mijn hoe waarom waar kan zou wil moet gaan geen'),
  pl: words('nie to się że na w z do i jest tak ale co jak po czy ja ty on ona my wy oni już tylko być mam masz ma może dla przez nic tu tam teraz bardzo dobrze proszę dziękuję'),
  sv: words('och att det är en jag inte på som för med den av har du vi de ni han hon ett men så om var kan ska vill nu här där bara mycket ja nej vad hur varför då mig dig'),
  da: words('og at det er en jeg ikke på som for med den af har du vi de han hun et men så om var kan skal vil nu her der bare meget ja nej hvad hvordan hvorfor mig dig nogen sådan også være'),
  no: words('og at det er en jeg ikke på som for med den av har du vi de han hun et men så om var kan skal vil nå her der bare mye ja nei hva hvordan hvorfor meg deg noen sånn også være'),
  fi: words('ja on ei se että en olen oli mitä kun minä sinä hän me te he mutta niin kuin tämä joka kyllä ole ovat vain nyt tässä siellä hyvin kiitos'),
  ro: words('şi să de în nu că este un o la cu pe ce eu tu el ea noi voi ei sunt am ai are da mai dar pentru cum când unde foarte aici acolo acum bine vă te mă îmi îți'),
  cs: words('a se že to je na v s do jsem jsi jsou ale ne ano co jak by už jen tak být mám máš má nebo pro tady tam teď velmi dobře prosím děkuji'),
  hu: words('a az és hogy nem egy is de van meg ez azt mit ki én te ő mi ti ők volt lesz már csak még igen nincs itt ott most nagyon jó kérem'),
  id: words('yang dan di ini itu dengan untuk tidak akan pada adalah dari saya kamu dia kami kita mereka ke ada juga sudah tapi atau apa bisa jangan sangat terima kasih tolong ya'),
  vi: words('và là của có không được một những cho này tôi bạn anh chị em ta họ với trong để đã sẽ rất cũng khi như nhưng thì ở đây đó gì sao'),
  ru: words('и в не на я что он с это как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну если уже или ни быть был до вас там потом себя ничего может они тут где есть надо для мы тебя их чем была сам без тогда кто этот того потому этого какой совсем здесь один мой чтобы сейчас были куда зачем всех никогда можно при наконец после больше через эти нас про всего много хорошо'),
  uk: words('і в не на я що він з це як а то всі вона так його але ти до у же ви за би по тільки її мені було ось від мене ще ні про із йому тепер коли навіть ну якщо вже або бути був вас там потім себе нічого може вони тут де є треба для ми тебе їх чим була сам без тоді хто цей того тому цього який зовсім один мій чому добре дуже'),
  bg: words('и на да се не е за са от като по но те то аз ти той тя ние вие има това ще или бях бил беше много тук там сега добре моля благодаря какво как защо кой коя които с в а ли ми ни му й ги'),
  ar: words('في من على أن إلى ما هذا لا هل هو هي أنا أنت نحن هم كان قد لم لن مع عن كل ذلك التي الذي هناك هنا الآن جدا نعم شكرا أيضا لكن إذا بعد قبل'),
  fa: words('در به از که این را با است برای آن یک من تو او ما شما آنها هم نه بله اما هر چه چرا کجا کی خیلی الان اینجا آنجا بود شد می نمی باید خوب'),
  ur: words('کے میں کی ہے اور سے کو نہیں یہ ہیں پر کا ایک تھا تھی وہ ہم آپ جو کیا بھی لیکن اگر ہو'),
  el: words('και να το δεν οτι τον την με για που τα της ο η οι ενα ειναι θα σε απο αυτο πως τι ναι οχι εγω εσυ μου σου'),
  he: words('של את לא אני זה על מה יש הוא היא אתה אנחנו הם כן גם אבל אם עם כל יותר רק עוד איך למה'),
  hi: words('है और के में की का से को यह नहीं हैं पर एक था थी वह हम आप जो क्या भी लेकिन अगर हो मैं तुम')
};
// Letters that belong (nearly) to one language: each one found counts as a third of a common word.
const SIGNS = { tr: /[ğşı]/g, pl: /[ąęłńśźż]/g, cs: /[ěřůťďň]/g, ro: /[ășțşţ]/g, hu: /[őű]/g, da: /[æø]/g, no: /[æø]/g, de: /ß/g, fr: /œ/g, es: /[ñ¿¡]/g, pt: /[ãõ]/g, vi: /[đơưạảấầẩẫậắằẳẵặẹẻẽếềểễệịỉọỏốồổỗộớờởỡợụủứừửữựỳỷỹỵ]/g, uk: /[їєґі]/g, bg: /ъ/g, ru: /[ыэё]/g, fa: /[پچژگ]/g, ur: /[ٹڈڑںےھ]/g };
const GROUPS = {
  latin: ['tr', 'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'sv', 'da', 'no', 'fi', 'ro', 'cs', 'hu', 'id', 'vi'],
  cyrillic: ['ru', 'uk', 'bg'], arabic: ['ar', 'fa', 'ur'], greek: ['el'], hebrew: ['he'], devanagari: ['hi']
};

const normalize = text => text.replace(/i̇/g, 'i').replace(/[ً-ٰٟـ֑-ׇ]/g, '')
  .replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/ى/g, 'ی').replace(/ة/g, 'ه').replace(/[أإآ]/g, 'ا').replace(/ё/g, 'е').replace(/ș/g, 'ş').replace(/ț/g, 'ţ');
const stripAccents = text => text.normalize('NFD').replace(/[̀-ͯ]/g, '');
const SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([code, list]) => [code, new Set(list.map(word => (code === 'el' ? stripAccents(normalize(word)) : normalize(word))))]));

export function scriptOf(code) {
  if (code >= 0x41 && code < 0x250 || code >= 0x1e00 && code <= 0x1eff) return 'latin';
  if (code >= 0x370 && code <= 0x3ff || code >= 0x1f00 && code <= 0x1fff) return 'greek';
  if (code >= 0x400 && code <= 0x52f) return 'cyrillic';
  if (code >= 0x590 && code <= 0x5ff) return 'hebrew';
  if (code >= 0x600 && code <= 0x6ff || code >= 0x750 && code <= 0x77f || code >= 0xfb50 && code <= 0xfdff || code >= 0xfe70 && code <= 0xfeff) return 'arabic';
  if (code >= 0x900 && code <= 0x97f) return 'devanagari';
  if (code >= 0xe00 && code <= 0xe7f) return 'thai';
  if (code >= 0xac00 && code <= 0xd7af || code >= 0x1100 && code <= 0x11ff || code >= 0x3130 && code <= 0x318f) return 'hangul';
  if (code >= 0x3040 && code <= 0x30ff || code >= 0x31f0 && code <= 0x31ff) return 'kana';
  if (code >= 0x4e00 && code <= 0x9fff || code >= 0x3400 && code <= 0x4dbf || code >= 0xf900 && code <= 0xfaff) return 'han';
  return 'other';
}
const THAI_COMMON = /ที่|ไม่|และ|ของ|ได้|ใน|เป็น|การ|ความ|ว่า|มี|นี้|จะ|ไป|ฉัน|คุณ/g;

/**
 * What the text looks like: the dominant script, its share of all letters and, when words decide, the languages ranked by the share
 * of common words (`score` is the best ratio and the figure encodings are compared by).
 */
export function analyseText(raw) {
  const text = String(raw || '').slice(0, 120000).normalize('NFC');
  const counts = {}; let letters = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    const script = scriptOf(ch.codePointAt(0)); counts[script] = (counts[script] || 0) + 1; letters++;
  }
  if (letters < 10) return { letters, script: null, share: 0, ranked: [], direct: null, score: 0 };
  const cjk = (counts.han || 0) + (counts.kana || 0);
  let script = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0], share = counts[script] / letters;
  if (cjk / letters > share) { script = 'han'; share = cjk / letters; }
  const result = { letters, script, share, ranked: [], pair: null, direct: null, score: 0, words: 0 };
  if (share < 0.75) return result; // two languages in one file (a bilingual subtitle): no guess
  if (script === 'han' || script === 'kana') { result.direct = (counts.kana || 0) / cjk >= 0.05 ? 'ja' : 'zh'; return result; }
  if (script === 'hangul') { result.direct = 'ko'; return result; }
  if (script === 'thai') {
    const hits = (text.match(THAI_COMMON) || []).length; result.score = hits / counts.thai * 3; if (result.score >= 0.08) result.direct = 'th'; return result;
  }
  let lower = text.toLowerCase();
  if (script === 'cyrillic') { // Serbian and Macedonian have their own letters: a few of them settle it
    if ((lower.match(/[ђћљњџ]/g) || []).length >= 3) { result.direct = 'sr'; return result; }
    if ((lower.match(/[ѓќѕ]/g) || []).length >= 3) { result.direct = 'mk'; return result; }
  }
  const candidates = GROUPS[script]; if (!candidates) return result;
  const signs = {}; for (const code of candidates) signs[code] = SIGNS[code] ? (lower.match(SIGNS[code]) || []).length / 3 : 0;
  lower = normalize(lower); if (script === 'greek') lower = stripAccents(lower);
  const tokens = (lower.match(/[\p{L}\p{M}'’]+/gu) || []).map(token => token.replace(/’/g, "'"));
  if (tokens.length < 20) return result;
  const hits = Object.fromEntries(candidates.map(code => [code, 0]));
  // one-letter words are left out: broken bytes cut text into one-letter pieces that would match them by chance
  for (const token of tokens) if (token.length > 1) for (const code of candidates) if (SETS[code].has(token)) hits[code]++;
  // words alone say whether it is a language at all; the letters of one language only help to choose between close pages
  result.ranked = Object.entries(hits).map(([code, count]) => [code, (count + signs[code]) / tokens.length]).sort((a, b) => b[1] - a[1]);
  result.score = result.ranked[0][1]; result.words = hits[result.ranked[0][0]] / tokens.length;
  // Close relatives (Danish/Norwegian...) share most common words: what tells them apart is the words only one of them has.
  const [a, b] = result.ranked;
  if (b) { const only = (x, y) => tokens.filter(token => SETS[x].has(token) && !SETS[y].has(token)).length + signs[x]; result.pair = [only(a[0], b[0]), only(b[0], a[0])]; }
  return result;
}

/** An ISO 639-1 code, or null when the text does not make it clear (too little text, mixed scripts, close competitors). */
export function guessLanguageFromText(text) {
  const info = analyseText(text);
  if (info.direct) return info.direct;
  const [best, second] = info.ranked;
  if (!best || best[1] < 0.08) return null;
  const clear = !second || best[1] >= second[1] * 1.4 || (info.pair && info.pair[0] >= 3 && info.pair[0] >= info.pair[1] * 2);
  return clear ? best[0] : null;
}
