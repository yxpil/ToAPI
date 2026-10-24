// @author yxpil
import { randomUUID } from 'node:crypto'

/** Postman 动态变量（23 号文档 §4.5）：每次取值独立求值，未知名返回 undefined */

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)] as T
const int = (min: number, max: number): number => min + Math.floor(Math.random() * (max - min + 1))
const digits = (n: number): string => Array.from({ length: n }, () => int(0, 9)).join('')
const hex = (n: number): string => Array.from({ length: n }, () => int(0, 15).toString(16)).join('')

const FIRST_NAMES = [
  'James',
  'Mary',
  'John',
  'Patricia',
  'Robert',
  'Jennifer',
  'Michael',
  'Linda',
  'William',
  'Elizabeth',
  'David',
  'Barbara',
  'Richard',
  'Susan',
  'Joseph',
  'Jessica',
  'Thomas',
  'Sarah',
  'Charles',
  'Karen',
  '林',
  '王',
  '李',
  '张',
]
const LAST_NAMES = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Garcia',
  'Miller',
  'Davis',
  'Rodriguez',
  'Martinez',
  'Hernandez',
  'Lopez',
  'Wilson',
  'Anderson',
  '伟',
  '芳',
  '娜',
  '敏',
]
const NAME_PREFIXES = ['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Miss']
const NAME_SUFFIXES = ['Jr.', 'Sr.', 'II', 'III', 'IV', 'PhD', 'MD']
const JOB_AREAS = ['Engineering', 'Marketing', 'Sales', 'Support', 'Design', 'Finance', 'Legal']
const JOB_DESCRIPTORS = ['Lead', 'Senior', 'Direct', 'Corporate', 'Dynamic', 'Future', 'Product']
const JOB_TITLES = ['Engineer', 'Manager', 'Analyst', 'Consultant', 'Coordinator', 'Specialist']
const JOB_TYPES = ['Engineer', 'Manager', 'Analyst', 'Developer', 'Architect', 'Strategist']
const CITIES = ['Shanghai', 'Beijing', 'San Francisco', 'Berlin', 'Tokyo', 'London', 'Sydney']
const STREET_NAMES = ['Second', 'Oak', 'Maple', 'Cedar', 'Pine', 'Lake', 'Hill', 'Washington']
const COUNTRIES = ['China', 'United States', 'Germany', 'Japan', 'France', 'Australia', 'Canada']
const COUNTRY_CODES = ['CN', 'US', 'DE', 'JP', 'FR', 'AU', 'CA']
const COLORS = ['red', 'green', 'blue', 'yellow', 'purple', 'orange', 'black', 'white']
const MIME_TYPES = [
  'application/json',
  'application/xml',
  'text/plain',
  'text/html',
  'image/png',
  'image/jpeg',
  'application/octet-stream',
]
const CURRENCIES = [
  { code: 'USD', name: 'US Dollar', symbol: '$' },
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'CNY', name: 'Chinese Yuan', symbol: '¥' },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
  { code: 'GBP', name: 'Pound Sterling', symbol: '£' },
]
const COMPANY_SUFFIXES = ['Inc', 'LLC', 'Group', 'and Sons', 'Ltd', 'PLC']
const BS_ADJECTIVES = [
  'clicks-and-mortar',
  'value-added',
  'vertical',
  'proactive',
  'robust',
  'revolutionary',
]
const BS_BUZZ = [
  'synergies',
  'web-readiness',
  'paradigms',
  'markets',
  'partnerships',
  'infrastructures',
]
const BS_NOUNS = ['e-tailers', 'e-services', 'action-items', 'portals', 'niches', 'solutions']
const CATCH_ADJECTIVES = ['Adaptive', 'Advanced', 'Configurable', 'Distributed', 'Enterprise-wide']
const CATCH_DESCRIPTORS = [
  '24/7',
  '24/365',
  'global',
  'next generation',
  'web-enabled',
  'visionary',
]
const CATCH_NOUNS = ['capability', 'architecture', 'interface', 'solution', 'strategy', 'framework']
const PRODUCT_ADJECTIVES = ['Small', 'Ergonomic', 'Rustic', 'Intelligent', 'Gorgeous', 'Practical']
const PRODUCT_MATERIALS = ['Steel', 'Wooden', 'Cotton', 'Granite', 'Rubber', 'Plastic']
const PRODUCT_NAMES = ['Chair', 'Car', 'Computer', 'Keyboard', 'Mouse', 'Bike', 'Ball', 'Gloves']
const DEPARTMENTS = ['Books', 'Movies', 'Music', 'Games', 'Electronics', 'Computers', 'Garden']
const TRANSACTION_TYPES = ['deposit', 'withdrawal', 'payment', 'invoice']
const FILE_EXTS = ['pdf', 'txt', 'png', 'jpg', 'csv', 'json', 'mp3', 'zip']
const FILE_TYPES = ['application', 'audio', 'image', 'text', 'video', 'message']
const DOMAIN_SUFFIXES = ['com', 'net', 'org', 'io', 'dev']
const DOMAIN_WORDS = ['example', 'sample', 'demo', 'test', 'acme', 'globex']
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
]
const LOCALES = ['en_US', 'en_GB', 'zh_CN', 'de_DE', 'ja_JP', 'fr_FR', 'es_ES']
const IMAGE_CATEGORIES = [
  'abstract',
  'animals',
  'business',
  'cats',
  'city',
  'food',
  'nightlife',
  'fashion',
  'people',
  'nature',
  'sports',
  'transport',
]

const imageUrl = (category: string): string =>
  `https://picsum.photos/seed/${category}-${int(1, 9999)}/600/400`

const domain = (): string => `${pick(DOMAIN_WORDS)}.${pick(DOMAIN_SUFFIXES)}`
const firstName = (): string => pick(FIRST_NAMES)
const lastName = (): string => pick(LAST_NAMES)
const userName = (): string =>
  `${firstName()}.${lastName()}`.toLowerCase().replace(/[^a-z0-9.]/g, '')
const email = (suffix = 'example.com'): string => `${userName()}@${suffix}`
const word = (): string => pick(DOMAIN_WORDS)
const fileName = (): string => `${word()}-${word()}.${pick(FILE_EXTS)}`
const commonFileName = (): string =>
  `${pick(['document', 'report', 'invoice', 'photo', 'data'])}.${pick(FILE_EXTS)}`
const filePath = (): string => `/home/user/${fileName()}`
const catchPhrase = (): string =>
  `${pick(CATCH_ADJECTIVES)} ${pick(CATCH_DESCRIPTORS)} ${pick(CATCH_NOUNS)}`

const GENERATORS: Record<string, () => string> = {
  $guid: () => randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomUUID: () => randomUUID(),
  $randomAlphaNumeric: () => pick('abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  $randomBoolean: () => pick(['true', 'false']),
  $randomInt: () => String(int(0, 1000)),
  $randomSemver: () => `${int(0, 9)}.${int(0, 9)}.${int(0, 9)}`,

  $randomIP: () => `${int(1, 255)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`,
  $randomIPV6: () =>
    Array.from({ length: 8 }, () => hex(4))
      .join(':')
      .toUpperCase(),
  $randomMACAddress: () => Array.from({ length: 6 }, () => hex(2).toUpperCase()).join(':'),
  $randomProtocol: () => pick(['http', 'https']),
  $randomUserAgent: () => pick(USER_AGENTS),
  $randomLocale: () => pick(LOCALES),

  $randomFirstName: firstName,
  $randomLastName: lastName,
  $randomFullName: () => `${firstName()} ${lastName()}`,
  $randomNamePrefix: () => pick(NAME_PREFIXES),
  $randomNameSuffix: () => pick(NAME_SUFFIXES),
  $randomJobArea: () => pick(JOB_AREAS),
  $randomJobDescriptor: () => pick(JOB_DESCRIPTORS),
  $randomJobTitle: () => pick(JOB_TITLES),
  $randomJobType: () => pick(JOB_TYPES),

  $randomPhoneNumber: () => `1${int(3, 9)}${digits(9)}`,
  $randomPhoneNumberExt: () => `${digits(3)}-${digits(4)}`,
  $randomCity: () => pick(CITIES),
  $randomStreetName: () => pick(STREET_NAMES),
  $randomStreetAddress: () => `${int(1, 9999)} ${pick(STREET_NAMES)} St`,
  $randomCountry: () => pick(COUNTRIES),
  $randomCountryCode: () => pick(COUNTRY_CODES),
  $randomLatitude: () => (Math.random() * 180 - 90).toFixed(6),
  $randomLongitude: () => (Math.random() * 360 - 180).toFixed(6),

  $randomColor: () => pick(COLORS),
  $randomHexColor: () => `#${hex(6)}`,
  $randomAbbreviation: () => pick(['HTTP', 'API', 'JSON', 'URL', 'SQL', 'TCP', 'XML']),
  $randomPassword: () =>
    `${pick('ABCDEFGHJKLMNPQRSTUVWXYZ'.split(''))}${hex(4)}${pick('!@#$%^&*'.split(''))}`,
  $randomMimeType: () => pick(MIME_TYPES),

  $randomAvatarImage: () => `https://i.pravatar.cc/300?u=${randomUUID()}`,
  $randomImageUrl: () => imageUrl('random'),
  $randomAbstractImage: () => imageUrl('abstract'),
  $randomAnimalsImage: () => imageUrl('animals'),
  $randomBusinessImage: () => imageUrl('business'),
  $randomCatsImage: () => imageUrl('cats'),
  $randomCityImage: () => imageUrl('city'),
  $randomFoodImage: () => imageUrl('food'),
  $randomNightlifeImage: () => imageUrl('nightlife'),
  $randomFashionImage: () => imageUrl('fashion'),
  $randomPeopleImage: () => imageUrl('people'),
  $randomNatureImage: () => imageUrl('nature'),
  $randomSportsImage: () => imageUrl('sports'),
  $randomTransportImage: () => imageUrl('transport'),
  $randomImageSourceUrl: () => imageUrl(pick(IMAGE_CATEGORIES)),

  $randomBankAccount: () => digits(12),
  $randomBankAccountName: () => `${firstName()} ${lastName()}`,
  $randomCreditCardMask: () => `****${digits(4)}`,
  $randomBankAccountBic: () =>
    `${hex(4).toUpperCase()}${pick(['CN', 'US', 'DE', 'JP'])}${hex(2).toUpperCase()}`,
  $randomBankAccountIban: () => `IBAN${digits(16)}`,
  $randomTransactionType: () => pick(TRANSACTION_TYPES),
  $randomCurrencyCode: () => pick(CURRENCIES).code,
  $randomCurrencyName: () => pick(CURRENCIES).name,
  $randomCurrencySymbol: () => pick(CURRENCIES).symbol,
  $randomBitcoin: () => (Math.random() * 2).toFixed(8),

  $randomCompanyName: () => `${pick(LAST_NAMES)} ${pick(COMPANY_SUFFIXES)}`,
  $randomCompanySuffix: () => pick(COMPANY_SUFFIXES),
  $randomBs: () => `${pick(BS_ADJECTIVES)} ${pick(BS_BUZZ)} ${pick(BS_NOUNS)}`,
  $randomBsAdjective: () => pick(BS_ADJECTIVES),
  $randomBsBuzz: () => pick(BS_BUZZ),
  $randomBsNoun: () => pick(BS_NOUNS),
  $randomCatchPhrase: catchPhrase,
  $randomCatchPhraseAdjective: () => pick(CATCH_ADJECTIVES),
  $randomCatchPhraseDescriptor: () => pick(CATCH_DESCRIPTORS),
  $randomCatchPhraseNoun: () => pick(CATCH_NOUNS),
  $randomDepartment: () => pick(DEPARTMENTS),

  $randomProduct: () => pick(PRODUCT_NAMES),
  $randomProductAdjective: () => pick(PRODUCT_ADJECTIVES),
  $randomProductMaterial: () => pick(PRODUCT_MATERIALS),
  $randomProductName: () =>
    `${pick(PRODUCT_ADJECTIVES)} ${pick(PRODUCT_MATERIALS)} ${pick(PRODUCT_NAMES)}`,
  $randomPrice: () => (Math.random() * 1000).toFixed(2),

  $randomEmail: () => email(),
  $randomExampleEmail: () => email('example.com'),
  $randomUserName: userName,
  $randomUrl: () => `https://${domain()}/${word()}`,
  $randomDomainName: domain,
  $randomDomainSuffix: () => pick(DOMAIN_SUFFIXES),
  $randomDomainWord: word,
  $randomFileExt: () => pick(FILE_EXTS),
  $randomFileName: fileName,
  $randomFileType: () => pick(FILE_TYPES),
  $randomFilePath: filePath,
  $randomCommonFileName: commonFileName,
  $randomCommonFileExt: () => pick(FILE_EXTS),
  $randomCommonFileType: () => pick(FILE_TYPES),
  $randomDirectoryPath: () => `/home/user/${word()}`,
}

export const DYNAMIC_VAR_NAMES: readonly string[] = Object.freeze(Object.keys(GENERATORS).sort())

/** 未知动态变量返回 undefined，由求值器保留原文（23 号文档 §4.5） */
export const dynamicVar = (name: string): string | undefined => {
  const hit = GENERATORS[name]
  return hit ? hit() : undefined
}
