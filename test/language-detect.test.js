import assert from 'node:assert/strict';
import test from 'node:test';
import { guessLanguageFromText, analyseText } from '../src/language-detect.js';
import { decodeText } from '../src/text-decode.js';

// Natural sentences of the kind found in subtitles: "I do not know what you want from me..." in many languages.
const SAMPLES = {
  tr: 'Senden ne istediğimi bilmiyorum ama bu çok önemli. Şimdi gitmemiz gerekiyor çünkü hava karardı. Sen ne dedin? Bunu bana daha önce söylemeliydin, değil mi? Ben hiçbir şey anlamıyorum ve bir cevap istiyorum.',
  ru: 'Я не знаю, что ты хочешь от меня. Это было так давно, и теперь все изменилось. Мы должны идти, потому что уже поздно. Что ты сказал? Я не понимаю, как это могло случиться с нами.',
  uk: 'Я не знаю, що ти хочеш від мене. Це було так давно, і тепер все змінилося. Ми повинні йти, тому що вже пізно. Що ти сказав? Я не розумію, як це могло статися з нами. Він дуже добре знає, де є ця їжа.',
  bg: 'Аз не знам какво искаш от мен. Това беше много отдавна и сега всичко е различно. Ние трябва да тръгваме, защото вече е късно. Какво каза ти? Не разбирам как това може да се случи с нас. Тук има много хора, които са там.',
  ar: 'أنا لا أعرف ماذا تريد مني. كان هذا قبل وقت طويل وكل شيء قد تغير الآن. نحن يجب أن نذهب لأن الوقت متأخر. هل تفهم ما قلته لك؟ لا أستطيع أن أصدق ما حدث هنا مع كل هذا.',
  fa: 'من نمی دانم که تو چه می خواهی از من. این خیلی وقت پیش بود و حالا همه چیز عوض شده است. ما باید برویم برای اینکه دیر شده است. تو چه گفتی؟ من نمی توانم باور کنم که این اتفاق برای ما افتاده است. او هم اینجا بود و با ما آمد.',
  ur: 'میں نہیں جانتا کہ آپ مجھ سے کیا چاہتے ہیں۔ یہ بہت پہلے کی بات ہے اور اب سب کچھ بدل چکا ہے۔ ہم کو جانا ہے کیونکہ دیر ہو گئی ہے۔ آپ نے کیا کہا؟ یہ سب کچھ ہمارے ساتھ ہوا ہے اور وہ بھی یہاں تھا۔',
  el: 'Δεν ξέρω τι θέλεις από εμένα. Αυτό ήταν πριν από πολύ καιρό και τώρα όλα έχουν αλλάξει. Πρέπει να φύγουμε γιατί είναι αργά. Τι είπες; Δεν μπορώ να πιστέψω ότι αυτό έγινε σε εμάς και με το που ήρθες.',
  he: 'אני לא יודע מה אתה רוצה ממני. זה היה לפני הרבה זמן ועכשיו הכל השתנה. אנחנו צריכים ללכת כי כבר מאוחר. מה אמרת? אני לא יכול להאמין שזה קרה לנו גם כאן עם כל זה.',
  hi: 'मैं नहीं जानता कि तुम मुझसे क्या चाहते हो। यह बहुत पहले की बात है और अब सब कुछ बदल चुका है। हम को जाना है क्योंकि देर हो गई है। तुम ने क्या कहा? यह सब कुछ हमारे साथ हुआ है और वह भी यहाँ था।',
  th: 'ฉันไม่รู้ว่าคุณต้องการอะไรจากฉัน นี่เป็นเรื่องที่เกิดขึ้นนานมาแล้วและตอนนี้ทุกอย่างเปลี่ยนไป เราต้องไปเพราะมันดึกแล้ว คุณพูดว่าอะไร ฉันไม่เชื่อว่ามันเกิดขึ้นกับเราได้',
  ja: 'あなたが私に何を望んでいるのか、私にはわかりません。それはずっと昔のことで、今はすべてが変わってしまいました。もう遅いので、私たちは行かなければなりません。あなたは何と言いましたか。',
  zh: '我不知道你想要我做什么。这是很久以前的事了，现在一切都变了。我们必须走了，因为已经很晚了。你说了什么？我不能相信这件事发生在我们身上。',
  ko: '나는 당신이 나에게 무엇을 원하는지 모르겠어요. 그것은 아주 오래전의 일이고 지금은 모든 것이 변했어요. 우리는 가야 해요, 이미 늦었으니까요. 당신은 뭐라고 말했나요?',
  nl: 'Ik weet niet wat je van mij wilt. Dat was een lange tijd geleden en nu is alles anders. We moeten gaan omdat het al laat is. Wat zei je? Ik kan niet geloven dat dit met ons is gebeurd en hij is er ook bij.',
  pl: 'Nie wiem, czego ty ode mnie chcesz. To było bardzo dawno temu i teraz wszystko się zmieniło. Musimy iść, bo już jest późno. Co ty powiedziałeś? Nie mogę uwierzyć, że to się stało i że on tu jest.',
  sv: 'Jag vet inte vad du vill ha av mig. Det var för mycket länge sedan och nu är allt annorlunda. Vi måste gå eftersom det är sent. Vad sa du? Jag kan inte tro att det har hänt oss och att han är här.',
  da: 'Jeg ved ikke hvad du vil have af mig. Det var for meget lang tid siden og nu er alt anderledes. Vi skal gå fordi det er sent. Hvad sagde du? Jeg kan ikke tro at det er sket med os og at han er her.',
  no: 'Jeg vet ikke hva du vil ha av meg. Det var for veldig lenge siden og nå er alt annerledes. Vi må gå fordi det er sent. Hva sa du? Jeg kan ikke tro at det har skjedd med oss og at han er her også.',
  fi: 'En tiedä mitä sinä haluat minulta. Se oli kauan sitten ja nyt kaikki on toisin. Meidän täytyy mennä koska on jo myöhä. Mitä sinä sanoit? En voi uskoa että tämä tapahtui meille ja hän on myös täällä.',
  ro: 'Nu știu ce vrei de la mine. Asta a fost acum mult timp și acum totul este altfel. Trebuie să plecăm pentru că este târziu. Ce ai spus? Nu pot să cred că asta ni s-a întâmplat și că el este aici cu noi.',
  cs: 'Nevím, co ode mě chceš. To bylo už dávno a teď je všechno jinak. Musíme jít, protože je už pozdě. Co jsi řekl? Nemohu uvěřit, že se to stalo nám a že on je tady.',
  hu: 'Nem tudom, mit akarsz tőlem. Ez nagyon régen volt, és most minden más. Mennünk kell, mert már késő van. Mit mondtál? Nem hiszem el, hogy ez velünk történt, és hogy ő itt van most.',
  id: 'Saya tidak tahu apa yang kamu inginkan dari saya. Itu sudah lama sekali dan sekarang semuanya berbeda. Kita harus pergi karena sudah malam. Apa yang kamu katakan? Saya tidak bisa percaya ini terjadi pada kita dan dia ada di sini.',
  vi: 'Tôi không biết bạn muốn gì ở tôi. Chuyện đó đã xảy ra rất lâu rồi và bây giờ mọi thứ đã khác. Chúng ta phải đi vì đã muộn. Bạn đã nói gì? Tôi không thể tin điều này đã xảy ra với chúng ta và họ ở đây.',
  en: "I don't know what you want from me. That was a long time ago and now everything is different. We have to go because it is late. What did you say? I can't believe this happened to us and that he is here too.",
  de: 'Ich weiß nicht, was du von mir willst. Das war vor sehr langer Zeit und jetzt ist alles anders. Wir müssen gehen, weil es schon spät ist. Was hast du gesagt? Ich kann nicht glauben, dass das uns passiert ist und dass er auch hier ist.',
  fr: "Je ne sais pas ce que tu veux de moi. C'était il y a très longtemps et maintenant tout est différent. Nous devons partir parce qu'il est tard. Qu'est-ce que tu as dit ? Je ne peux pas croire que cela nous soit arrivé et qu'il soit aussi ici.",
  es: 'No sé lo que quieres de mí. Eso fue hace mucho tiempo y ahora todo es diferente. Tenemos que irnos porque es tarde. ¿Qué dijiste? No puedo creer que esto nos haya pasado a nosotros y que él esté aquí también.',
  it: 'Non so cosa vuoi da me. È stato molto tempo fa e adesso tutto è diverso. Dobbiamo andare perché è tardi. Che cosa hai detto? Non posso credere che questo sia successo a noi e che anche lui sia qui.',
  pt: 'Eu não sei o que você quer de mim. Isso foi há muito tempo e agora tudo é diferente. Nós temos que ir porque está tarde. O que você disse? Não posso acreditar que isso aconteceu com a gente e que ele está aqui também.'
};
const manyTimes = text => Array.from({ length: 4 }, () => text).join('\n');
// The same bytes a legacy program would have written: the browser's own decoder run backwards.
const encoders = new Map();
function encode(label, text) {
  if (!encoders.has(label)) {
    const map = new Map(), decoder = new TextDecoder(label);
    for (let a = 0; a < 256; a++) { const ch = decoder.decode(Uint8Array.of(a)); if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [a]); }
    if (!['windows-1250', 'windows-1251', 'windows-1252', 'windows-1253', 'windows-1254', 'windows-1255', 'windows-1256', 'windows-1257', 'windows-874', 'koi8-r'].includes(label)) {
      for (let a = 0x81; a <= 0xfe; a++) for (let b = 0x40; b <= 0xfe; b++) { const ch = decoder.decode(Uint8Array.of(a, b)); if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [a, b]); }
    }
    encoders.set(label, map);
  }
  const map = encoders.get(label), bytes = [];
  for (const ch of text) { const value = map.get(ch); assert.ok(value, `${label} cannot hold "${ch}"`); bytes.push(...value); }
  return Buffer.from(bytes);
}

test('languages are told from their text: scripts and common words, in 30 languages', () => {
  for (const [code, text] of Object.entries(SAMPLES)) assert.equal(guessLanguageFromText(manyTimes(text)), code, code);
});
test('Chinese is told from Japanese by kana, and traditional characters are Chinese too', () => {
  assert.equal(guessLanguageFromText(SAMPLES.zh.replace(/[一-鿿]/g, ch => ch)), 'zh');
  assert.equal(guessLanguageFromText('我不知道你想要我做什麼。這是很久以前的事了，現在一切都變了。我們必須走了，因為已經很晚了。你說了什麼？'), 'zh');
});
test('not clear stays unknown: too little text, mixed scripts, gibberish, a rare script letter set', () => {
  assert.equal(guessLanguageFromText('Привет'), null);
  assert.equal(guessLanguageFromText(Array.from({ length: 3 }, () => SAMPLES.ru).join('\n') + manyTimes(SAMPLES.en)), null, 'two languages in one file: no guess');
  assert.equal(guessLanguageFromText(Array.from({ length: 40 }, () => 'Zxqv wplk mnbv tfrd').join(' ')), null);
  assert.equal(guessLanguageFromText(Array.from({ length: 40 }, () => 'Ժողովուրդ աշխարհի ամենամեծ ազգն է').join(' ')), null, 'a script with no list is not guessed');
});
test('close relatives are told apart only by the words that differ', () => {
  assert.equal(analyseText(SAMPLES.da).pair[0] >= 3, true);
  assert.equal(guessLanguageFromText(manyTimes(SAMPLES.da)), 'da'); assert.equal(guessLanguageFromText(manyTimes(SAMPLES.no)), 'no');
  const shared = 'Jeg ikke det er og at på som for med den har du vi de han hun et men så om var kan skal vil her der bare';
  assert.equal(guessLanguageFromText(manyTimes(shared)), null, 'only shared words: no pick between Danish and Norwegian');
});

// ---- Encodings: the file's bytes in the code page of its country ----
const FILES = [
  ['windows-1254', 'tr'], ['windows-1252', 'de'], ['windows-1252', 'fr'], ['windows-1252', 'es'], ['windows-1252', 'pt'], ['windows-1252', 'it'], ['windows-1252', 'sv'], ['windows-1252', 'da'], ['windows-1252', 'no'], ['windows-1252', 'fi'], ['windows-1252', 'nl'],
  ['windows-1250', 'pl'], ['windows-1250', 'cs'], ['windows-1250', 'hu'], ['windows-1251', 'ru'], ['windows-1251', 'uk'], ['windows-1251', 'bg'], ['koi8-r', 'ru'], ['windows-1253', 'el'], ['windows-1256', 'ar'], ['windows-1256', 'fa'],
  ['windows-1255', 'he'], ['windows-874', 'th'], ['gbk', 'zh'], ['big5', 'zh-t'], ['shift_jis', 'ja'], ['euc-jp', 'ja'], ['euc-kr', 'ko']
];
const SAMPLES_EXTRA = { 'zh-t': '我不知道你想要我做什麼。這是很久以前的事了，現在一切都變了。我們必須走了，因為已經很晚了。你說了什麼？我不能相信這件事發生在我們身上。' };
const srt = text => text.split(/(?<=[.!?。？])\s*/).filter(Boolean).map((line, i) => `${i + 1}\r\n00:00:${String(i * 2).padStart(2, '0')},000 --> 00:00:${String(i * 2 + 1).padStart(2, '0')},500\r\n${line}\r\n`).join('\r\n');
test('legacy code pages are told from the content and read back exactly', () => {
  for (const [label, language] of FILES) {
    const original = manyTimes(SAMPLES_EXTRA[language] || SAMPLES[language]);
    // Windows-1256 has no Persian yeh: Persian files of that code page use the Arabic letter
    const subtitle = srt(label === 'windows-1256' && language === 'fa' ? original.replace(/ی/g, 'ي') : original);
    const bytes = encode(label, subtitle);
    const result = decodeText(bytes);
    assert.equal(result.confident, true, `${label}/${language} confident`);
    assert.equal(result.text, subtitle, `${label}/${language} read back (${result.encoding})`);
  }
});
test('byte-order marks, UTF-16 without a mark and plain UTF-8 are recognised first', () => {
  const subtitle = srt(manyTimes(SAMPLES.ru));
  assert.equal(decodeText(Buffer.from(subtitle, 'utf8')).encoding, 'utf-8');
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(subtitle, 'utf8')])).text, subtitle);
  const le = Buffer.from(subtitle, 'utf16le'), be = Buffer.from(le).swap16();
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), le])).text, subtitle);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).text, subtitle);
  assert.deepEqual([decodeText(le).encoding, decodeText(le).text === subtitle], ['utf-16le', true]);
  assert.deepEqual([decodeText(be).encoding, decodeText(be).text === subtitle], ['utf-16be', true]);
  const chinese = Buffer.from(srt(manyTimes(SAMPLES.zh)), 'utf16le'); assert.equal(decodeText(chinese).encoding, 'utf-16le', 'a CJK file with ASCII time lines');
});
test('unclear bytes: a code page from the language hint, marked as not confident when much text depends on it', () => {
  // long "words" of high bytes: no common word of any language, whatever page they are read with
  const bytes = Buffer.from(Array.from({ length: 40 }, (_, w) => [...Array.from({ length: 8 }, (_, j) => 0xc0 + ((w * 13 + j * 7) % 64)), 0x20]).flat());
  const guess = decodeText(bytes, { hint: 'tr' });
  assert.equal(guess.encoding, 'windows-1254'); assert.equal(guess.confident, false); assert.equal(guess.suspect, true);
  assert.equal(decodeText(bytes).encoding, 'windows-1252', 'no hint: the common western page');
  const tiny = decodeText(Buffer.from('Merhaba, \xfe\xf0 nas\xfdls\xfdn', 'latin1'), { hint: 'tr' });
  assert.equal(tiny.suspect, false, 'a few letters of doubt are not worth a warning');
});
