/**
 * Decoy banks.
 *
 * A trivia question is only as good as its wrong answers. When the host gives us
 * "rock climbing" we want the other three options to also look like hobbies, not
 * like a cheese. Each keyword is sorted into a category, and decoys are drawn from
 * the matching bank so every option reads as equally plausible.
 */

export const CATEGORIES = {
  food: {
    label: 'food',
    noun: 'comfort food',
    cues: ['pizza', 'taco', 'sushi', 'pasta', 'bread', 'cheese', 'sandwich', 'burger', 'noodle',
      'soup', 'salad', 'cake', 'cookie', 'chocolate', 'ice cream', 'breakfast', 'brunch', 'bbq',
      'barbecue', 'curry', 'ramen', 'burrito', 'donut', 'pancake', 'waffle', 'cilantro', 'olives',
      'pickles', 'hot sauce', 'snack', 'candy', 'pie', 'eating', 'cooking', 'baking', 'food'],
    bank: ['breakfast burritos', 'pineapple on pizza', 'gas station taquitos', 'sourdough starters',
      'extra-spicy ramen', 'cold leftover pizza', 'peanut butter on everything', 'fancy grilled cheese',
      'midnight cereal', 'homemade salsa', 'deep-dish pizza', 'street tacos', 'chicken and waffles',
      'day-old bagels', 'pickle-flavored anything', 'buffet dessert bars', 'overnight oats',
      'a suspicious amount of hot sauce', 'gourmet mac and cheese', 'grocery store sushi']
  },
  drink: {
    label: 'drink',
    noun: 'drink order',
    cues: ['coffee', 'espresso', 'latte', 'tea', 'soda', 'dr pepper', 'coke', 'boba', 'smoothie',
      'juice', 'water', 'lemonade', 'kombucha', 'energy drink', 'cocoa', 'drink'],
    bank: ['iced coffee in a blizzard', 'gas station Diet Coke', 'oat milk lattes', 'boba with extra pearls',
      'room-temperature water', 'green smoothies', 'chai from a specific cafe', 'three espressos before noon',
      'sparkling water with lime', 'hot cocoa in July', 'energy drinks at 9pm', 'unsweetened iced tea']
  },
  activity: {
    label: 'hobby',
    noun: 'weekend hobby',
    cues: ['climbing', 'hiking', 'running', 'knitting', 'painting', 'drawing', 'gardening', 'reading',
      'writing', 'photography', 'camping', 'fishing', 'woodworking', 'pottery', 'sewing', 'crochet',
      'puzzle', 'board game', 'video game', 'gaming', 'baking', 'dancing', 'singing', 'karaoke',
      'yoga', 'thrifting', 'birding', 'hobby', 'collecting', 'building', 'restoring'],
    bank: ['competitive puzzle racing', 'restoring old bicycles', 'birdwatching at dawn', 'pottery classes',
      'geocaching', 'learning the banjo', 'thrift store treasure hunting', 'making sourdough',
      'building mechanical keyboards', 'urban sketching', 'salsa dancing lessons', 'fly fishing',
      'woodworking in the garage', 'astrophotography', 'roller skating', 'crocheting tiny animals',
      'metal detecting at the beach', 'indoor rock climbing', 'training for a half marathon',
      'collecting vintage postcards', 'stand-up paddleboarding', 'homebrewing']
  },
  sport: {
    label: 'sport',
    noun: 'sport',
    cues: ['basketball', 'football', 'soccer', 'baseball', 'tennis', 'golf', 'hockey', 'volleyball',
      'pickleball', 'swimming', 'skiing', 'snowboard', 'surf', 'skate', 'cycling', 'lifting',
      'crossfit', 'marathon', 'rugby', 'wrestling', 'sport', 'team', 'gym'],
    bank: ['pickleball at 6am', 'fantasy football', 'intramural volleyball', 'weekend pickup basketball',
      'competitive bowling', 'ultimate frisbee', 'rec league softball', 'spin class',
      'watching curling unironically', 'March Madness brackets', 'disc golf', 'sunrise swim practice']
  },
  music: {
    label: 'music',
    noun: 'guilty pleasure song',
    cues: ['music', 'song', 'band', 'album', 'guitar', 'piano', 'drums', 'violin', 'singing', 'concert',
      'playlist', 'taylor swift', 'beatles', 'jazz', 'country music', 'rap', 'karaoke', 'spotify'],
    bank: ['90s boy bands', 'an unreasonable number of Taylor Swift songs', 'bluegrass covers of pop songs',
      'movie soundtracks on repeat', 'the same album for four years straight', 'showtunes in the car',
      'early 2000s pop punk', 'lo-fi study beats', 'live jazz in tiny rooms', 'country road trip playlists',
      'yacht rock', 'singing harmony to the radio']
  },
  travel: {
    label: 'place',
    noun: 'happy place',
    cues: ['idaho', 'utah', 'texas', 'california', 'york', 'paris', 'london', 'japan', 'italy', 'mexico',
      'canada', 'hawaii', 'beach', 'mountain', 'lake', 'desert', 'national park', 'road trip', 'travel',
      'city', 'town', 'island', 'europe', 'cabin', 'camping trip'],
    bank: ['a very specific lake in the mountains', 'road trips with no itinerary', 'national park stamps',
      'a tiny beach town nobody has heard of', 'Tokyo in the spring', 'the Oregon coast',
      'anywhere with a hot spring', 'grandma’s cabin', 'Iceland in winter', 'New York City in December',
      'the middle of nowhere, Utah', 'a cruise they swore they’d hate']
  },
  animal: {
    label: 'animal',
    noun: 'animal soulmate',
    cues: ['dog', 'cat', 'puppy', 'kitten', 'horse', 'bird', 'fish', 'snake', 'lizard', 'rabbit',
      'hamster', 'pet', 'animal', 'goat', 'chicken', 'cow', 'otter', 'shark', 'retriever', 'corgi',
      'husky', 'poodle', 'doodle', 'terrier', 'beagle', 'puppies', 'kitty', 'parrot', 'turtle'],
    bank: ['golden retrievers', 'a deeply unfriendly cat', 'backyard chickens', 'otters',
      'their neighbor’s dog', 'rescue greyhounds', 'a betta fish named after a president',
      'miniature goats', 'red pandas', 'a bearded dragon', 'horses they never actually ride',
      'every dog at the dog park']
  },
  media: {
    label: 'show',
    noun: 'comfort rewatch',
    cues: ['movie', 'film', 'show', 'series', 'netflix', 'tv', 'book', 'novel', 'podcast', 'anime',
      'marvel', 'star wars', 'harry potter', 'lord of the rings', 'the office', 'documentary', 'reading'],
    bank: ['the same sitcom on repeat', 'true crime podcasts', 'nature documentaries',
      'every baking competition show', 'Lord of the Rings extended editions', 'reality dating shows',
      'a 900-page fantasy series', 'obscure 80s movies', 'sci-fi audiobooks at 2x speed',
      'home renovation shows', 'anime from the 90s', 'the Sunday crossword']
  },
  quirk: {
    label: 'quirk',
    noun: 'signature quirk',
    cues: ['always', 'never', 'hates', 'loves', 'refuses', 'terrified', 'afraid', 'obsessed', 'allergic',
      'cannot', 'can’t', 'won\'t', 'habit', 'superstition', 'ritual', 'pet peeve', 'quirk', 'laugh',
      'snores', 'sleeps', 'late', 'early'],
    bank: ['narrating what the dog is thinking', 'refusing to eat anything green',
      'alphabetizing the spice rack', 'quoting the same movie every single day',
      'being incapable of whispering', 'naming every houseplant', 'always losing exactly one sock',
      'saying "anyway" to end every phone call', 'keeping every receipt since 2014',
      'an aggressively specific coffee order', 'talking with their hands so much it’s a hazard',
      'falling asleep in the first ten minutes of any movie']
  },
  skill: {
    label: 'skill',
    noun: 'hidden talent',
    cues: ['can', 'speaks', 'language', 'spanish', 'french', 'coding', 'engineer', 'teacher', 'nurse',
      'doctor', 'lawyer', 'student', 'work', 'job', 'degree', 'major', 'talent', 'juggle', 'whistle',
      'magic', 'accent', 'skill'],
    bank: ['whistling with two fingers', 'speaking passable Portuguese', 'juggling exactly three things',
      'doing a perfect British accent', 'solving a Rubik’s cube in under two minutes',
      'parallel parking on the first try, always', 'remembering everyone’s birthday',
      'making balloon animals', 'card tricks', 'wiggling their ears',
      'naming any song in three notes', 'backing up a trailer perfectly']
  },
  style: {
    label: 'style',
    noun: 'signature look',
    cues: ['wears', 'shoes', 'boots', 'hat', 'jacket', 'shirt', 'dress', 'style', 'outfit', 'color',
      'flannel', 'jeans', 'socks', 'sunglasses', 'hair'],
    bank: ['the same flannel four days a week', 'aggressively loud socks', 'a hat collection nobody asked for',
      'sunglasses indoors', 'cowboy boots with everything', 'a jacket older than the friendship',
      'color-coordinated head to toe', 'Crocs, unapologetically', 'thrifted band tees',
      'one specific shade of green']
  },
  general: {
    label: 'thing',
    noun: 'signature thing',
    cues: [],
    bank: ['sending memes at 2am', 'winning every board game', 'an unreasonable love of office supplies',
      'being 15 minutes early to everything', 'giving unsolicited restaurant recommendations',
      'a spreadsheet for absolutely everything', 'adopting every stray in a five mile radius',
      'remembering plot details nobody else does', 'making friends in every checkout line',
      'planning trips they never take', 'the world’s most organized garage',
      'texting exclusively in voice memos']
  }
};

/** Normalize a phrase for comparison: lowercase, no punctuation, single spaces. */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Guess which bank a keyword belongs to by looking for cue words.
 * Falls back to 'general', which is deliberately broad and always usable.
 */
export function categorize(keyword) {
  const text = normalize(keyword);
  if (!text) return 'general';
  let best = 'general';
  let bestScore = 0;
  for (const [name, category] of Object.entries(CATEGORIES)) {
    let score = 0;
    for (const cue of category.cues) {
      // Longer cues are more specific: "dr pepper" should beat a stray "breakfast".
      const weight = cue.split(' ').length;
      if (text === cue) score += 3 * weight;
      else if (text.includes(cue)) score += 2 * weight;
    }
    // "-ing" words are almost always activities.
    if (name === 'activity' && /\b\w+ing\b/.test(text)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return best;
}

/**
 * Keywords can be things the guest loves or things they can't stand. "hates
 * cilantro" is a true fact, but it is not their favourite food — so questions
 * phrased as a preference ("their go-to comfort food") must not use it.
 */
const NEGATIVE_PATTERN = /\b(hates?|hated|hating|dislikes?|loathes?|despises?|refuses?|refusing|avoids?|never|not\s+a|no\s+good\s+at|terrible\s+at|bad\s+at|awful\s+at|worst\s+at|useless\s+at|can'?t|cannot|won'?t|allergic|afraid|scared|terrified|fears?|phobia)\b/;

export function isNegativeKeyword(keyword) {
  return NEGATIVE_PATTERN.test(normalize(keyword));
}

/** Words too common to count as a meaningful overlap between two phrases. */
const STOP_WORDS = new Set(['the', 'and', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'every', 'their', 'they', 'them', 'from', 'that', 'this', 'very', 'more', 'most', 'than', 'into',
  'about', 'over', 'under', 'some', 'any', 'all', 'one', 'two', 'three', 'never', 'always', 'same',
  'like', 'loves', 'hates', 'love', 'hate', 'has', 'have', 'been', 'being', 'wears', 'wear']);

/** Distinctive words in a phrase, used to detect answer-giveaway overlap. */
function contentWords(text) {
  return normalize(text)
    .split(' ')
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
}

/**
 * True when two phrases share a distinctive word. A decoy that repeats a real
 * keyword's own vocabulary ("the same flannel four days a week" next to "wears
 * flannel") either gives the answer away or reads as a trick, so we drop it.
 */
export function phrasesOverlap(a, b) {
  const left = contentWords(a);
  const right = new Set(contentWords(b));
  return left.some((word) => right.has(word));
}

/**
 * Decoys for a keyword: same-category options first, topped up from the
 * general bank, with anything resembling a real keyword filtered out.
 */
export function decoysFor(keyword, { rng, exclude = [], count = 3 }) {
  const category = categorize(keyword);
  const blockedPhrases = [keyword, ...exclude].map((item) => String(item ?? '')).filter(Boolean);
  const blocked = new Set(blockedPhrases.map(normalize).filter(Boolean));

  const usable = (list) => list.filter((item) => {
    const n = normalize(item);
    if (!n || blocked.has(n)) return false;
    for (const taken of blockedPhrases) {
      if (phrasesOverlap(n, taken)) return false;
    }
    return true;
  });

  const primary = rng.shuffle(usable(CATEGORIES[category].bank));
  const filler = rng.shuffle(usable(CATEGORIES.general.bank));
  const everything = rng.shuffle(
    usable(Object.values(CATEGORIES).flatMap((c) => c.bank))
  );

  const out = [];
  for (const source of [primary, filler, everything]) {
    for (const item of source) {
      if (out.length >= count) break;
      if (!out.some((existing) => normalize(existing) === normalize(item))) out.push(item);
    }
  }
  return out.slice(0, count);
}
