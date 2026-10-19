type PlaceLike = {
  name?: string;
  types?: string[];
  primaryType?: string | null;
  kind?: "hotel" | "sight" | "food" | "buffer" | string;
};

export type PlaceDescription = {
  categoryLabel: string;
  description: string;
};

function signal(place: PlaceLike) {
  return [place.name, place.primaryType, ...(place.types || []), place.kind]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function singaporePlaceCategory(place: PlaceLike) {
  const value = signal(place);
  if (/hotel|lodging|住宿|酒店/.test(value)) return "酒店";
  if (/dessert|bakery|bakeshop|candy|confection|ice_cream|sweet|delight|baklava|甜品|甜点|糖果|烘焙/.test(value)) return "甜品店";
  if (/cafe|coffee|tea_house|咖啡|茶馆/.test(value)) return "咖啡与茶饮店";
  if (/restaurant|meal|food|hawker|餐厅|餐馆|熟食|美食/.test(value)) return "餐厅";
  if (/perfume|aromatic|fragrance|essential_oil|香氛|香水|精油/.test(value)) return "香氛与精油商店";
  if (/museum|art_gallery|gallery|博物馆|美术馆|画廊/.test(value)) return "博物馆与展览空间";
  if (/place_of_worship|mosque|temple|church|synagogue|回教堂|清真寺|寺庙|教堂/.test(value)) return "宗教与文化建筑";
  if (/park|garden|nature|beach|trail|植物园|公园|花园|海滩|步道/.test(value)) return "公园与户外景点";
  if (/market|shopping_mall|department_store|store|shop|市场|商场|商店/.test(value)) return "特色商店";
  if (/bar|night_club|酒吧|夜店/.test(value)) return "酒吧与夜间场所";
  if (/zoo|aquarium|wildlife|动物园|水族馆/.test(value)) return "动物与自然景点";
  if (/tourist_attraction|landmark|historical|monument|景点|地标|古迹/.test(value)) return "城市景点";
  if (place.kind === "food") return "餐饮地点";
  if (place.kind === "buffer") return "自由活动地点";
  return "城市体验地点";
}

function safeTheme(theme?: string) {
  const value = theme?.trim().slice(0, 60);
  return value ? `“${value}”` : "当天";
}

export function describeSingaporePlace(place: PlaceLike, theme?: string): PlaceDescription {
  const categoryLabel = singaporePlaceCategory(place);
  const dayTheme = safeTheme(theme);
  const descriptions: Record<string, string> = {
    "酒店": "当天路线的出发或返回锚点。",
    "甜品店": `提供甜点与轻食选择，适合作为${dayTheme}步行过程中的短暂休息。`,
    "咖啡与茶饮店": `提供咖啡或茶饮，适合作为${dayTheme}行程中的休息停留。`,
    "餐厅": `提供正餐选择，安排为${dayTheme}行程中的用餐停留。`,
    "香氛与精油商店": `经营香氛、香水或精油类商品，适合作为${dayTheme}街区探索中的短暂停留。`,
    "博物馆与展览空间": `以展览或文化内容为主，与${dayTheme}的室内参观安排相衔接。`,
    "宗教与文化建筑": `具有宗教或社区文化属性，安排为${dayTheme}的文化参观地点。`,
    "公园与户外景点": `以绿地、海岸或户外步行为主，安排为${dayTheme}的户外停留。`,
    "特色商店": `以零售或在地商品为主，适合作为${dayTheme}街区探索中的短暂停留。`,
    "酒吧与夜间场所": `适合傍晚或夜间停留，与${dayTheme}的夜间安排相衔接。`,
    "动物与自然景点": `以动物或自然体验为主，安排为${dayTheme}的主要参观点。`,
    "城市景点": `可供参观或城市观察，与${dayTheme}的游览方向相符。`,
    "餐饮地点": `用于${dayTheme}行程中的用餐或休息。`,
    "自由活动地点": `用于自由探索和休息，为${dayTheme}保留弹性时间。`,
    "城市体验地点": `Google Places 已验证的真实地点，与${dayTheme}的体验方向相符。`,
  };
  return { categoryLabel, description: descriptions[categoryLabel] };
}
