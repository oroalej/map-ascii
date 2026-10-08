import { cityJson } from './city-json';
import { isCityArt, isCityLandmarks, isCityTours } from './guards';
export const loadLandmarks = cityJson('landmarks', isCityLandmarks);
export const loadTours = cityJson('tours', isCityTours);
const loadCityArt = cityJson('art', isCityArt);
export const loadArt = async (city: string) => (await loadCityArt(city)).pieces;
