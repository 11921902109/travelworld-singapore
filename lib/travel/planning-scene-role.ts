export type SceneRole = "culinary_area" | "restaurant_meal" | "attraction";
type Place = { name: string; primaryType?: string | null; types?: string[] };
export function planningSceneRole(place: Place): SceneRole {
  const types = [place.primaryType, ...(place.types || [])].filter(Boolean);
  if (types.includes("food_court") || /(?:hawker (?:centre|center|street)|food (?:centre|center|court|street)|美食街|美食区|熟食中心|食阁|小贩中心)(?:\s*\([^)]*\))?$/i.test(place.name.trim()) || /^(?:Lau Pa Sat|Tekka Centre|Geylang Serai Market)$/i.test(place.name.trim())) return "culinary_area";
  if (types.some((type) => /^(restaurant|cafe|coffee_shop|bakery|meal_takeaway|meal_delivery|bar)$/.test(type!))) return "restaurant_meal";
  return "attraction";
}

/** A general food interest permits areas, while individual meals require a named request. */
export function allowAutomaticFoodScene(place: Place, foodInterest: boolean, namedRequest: boolean): boolean {
  const role = planningSceneRole(place);
  return role === "attraction" || namedRequest || role === "culinary_area" && foodInterest;
}
