import json
from shapely.geometry import Polygon, LineString, MultiLineString
from pyproj import Transformer
import math

def generate_flight_lines_from_polygon(
    polygon_lonlat: list, 
    track_spacing_m: float, 
    altitude: int, 
    speed: float, 
    survey_type: str
):
    """
    Разрезает полигон (заданный в координатах долгота/широта) на параллельные 
    галсы с заданным расстоянием track_spacing_m (в метрах) между ними.
    """
    # 1. Настройка конвертации WGS84 <-> UTM (EPSG:4326 <-> EPSG:32637)
    # Зону 32637 можно брать динамически, но для примера ЦФО возьмём её
    transformer_to_m = Transformer.from_crs("EPSG:4326", "EPSG:32637", always_xy=True)
    transformer_to_lonlat = Transformer.from_crs("EPSG:32637", "EPSG:4326", always_xy=True)

    # 2. Конвертируем координаты полигона в метры
    polygon_m = Polygon([transformer_to_m.transform(lon, lat) for lon, lat in polygon_lonlat])

    # Получаем рамку в метрах (BBox)
    minx, miny, maxx, maxy = polygon_m.bounds
    
    # 3. Идем циклом по оси Y с шагом track_spacing_m и создаем горизонтальные отрезки (наши линии)
    current_y = miny
    lines_m = []
    
    while current_y <= maxy:
        # Создаем очень длинную линию от края до края (от X-мин до X-макс)
        horizontal_line = LineString([(minx - 100, current_y), (maxx + 100, current_y)])
        
        # Пересекаем её с полигоном (отрезаем то, что выходит за границы зоны съемки)
        intersection = polygon_m.intersection(horizontal_line)
        
        if not intersection.is_empty:
            # Обработка сложной геометрии (например, полигон "полумесяц")
            if isinstance(intersection, MultiLineString):
                for geom in intersection.geoms:
                    lines_m.append(geom)
            else:
                lines_m.append(intersection)
        
        current_y += track_spacing_m

    # 4. Формируем финальный массив в нужном формате
    results = []
    _id = 1
    
    for line in lines_m:
        # Вычисляем длину линии (оно сейчас в метрах!)
        length_m = round(line.length, 2)
        
        # Конвертируем стартовую и конечную точку обратно в долготу/широту (GeoJSON standard)
        start_pt_m, end_pt_m = line.coords[0], line.coords[-1]
        start_lon, start_lat = transformer_to_lonlat.transform(start_pt_m[0], start_pt_m[1])
        end_lon, end_lat     = transformer_to_lonlat.transform(end_pt_m[0], end_pt_m[1])
        
        results.append({
            "id": _id,
            "start_coords": [round(start_lon, 6), round(start_lat, 6)],
            "end_coords": [round(end_lon, 6), round(end_lat, 6)],
            "altitude": altitude,
            "speed": speed,
            "survey_type": survey_type,
            "length": length_m
        })
        _id += 1
        
    return results

# ================= ПРИМЕР ИСПОЛЬЗОВАНИЯ =================

if __name__ == "__main__":
    # Простой квадратный полигон поля 
    poly_coords = [
        (37.89, 55.67),
        (37.91, 55.67),
        (37.905, 55.665),
        (37.88, 55.668)
    ]
    
    # Режем: расстояние между линиями 50 метров (зависит от камеры перекрытия)
    tasks = generate_flight_lines_from_polygon(
        polygon_lonlat=poly_coords, 
        track_spacing_m=50,   
        altitude=150, 
        speed=15.0, 
        survey_type="RGB"
    )

    print(json.dumps(tasks, indent=2, ensure_ascii=False))