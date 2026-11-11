# ai_worker/scene_classifier.py
"""Scene classification using Places365 ResNet-50 ONNX model."""

import os
import sys
from typing import List, Optional
import numpy as np
from PIL import Image

# Allow running both as module and script
sys.path.insert(0, os.path.dirname(__file__))
from server import AiTag

# Official Places365 categories (365 classes) — from CSAILVision/places365
PLACES365_CATEGORIES = [
    "a_airfield", "a_airplane_cabin", "a_airport_terminal", "a_alcove", "a_alley",
    "a_amphitheater", "a_amusement_arcade", "a_amusement_park", "a_apartment_building_outdoor",
    "a_aquarium", "a_aqueduct", "a_arcade", "a_arch", "a_archaelogical_excavation",
    "a_archive", "a_arena_hockey", "a_arena_performance", "a_arena_rodeo", "a_army_base",
    "a_art_gallery", "a_art_school", "a_art_studio", "a_artists_loft", "a_assembly_line",
    "a_athletic_field_outdoor", "a_atrium_public", "a_attic", "a_auditorium", "a_auto_factory",
    "a_auto_showroom", "b_badlands", "b_bakery_shop", "b_balcony_exterior", "b_balcony_interior",
    "b_ball_pit", "b_ballroom", "b_bamboo_forest", "b_bank_vault", "b_banquet_hall",
    "b_bar", "b_barn", "b_barndoor", "b_baseball_field", "b_basement",
    "b_basketball_court_indoor", "b_bathroom", "b_bazaar_indoor", "b_bazaar_outdoor", "b_beach",
    "b_beach_house", "b_beauty_salon", "b_bedchamber", "b_bedroom", "b_beer_garden",
    "b_beer_hall", "b_berth", "b_biology_laboratory", "b_boardwalk", "b_boat_deck",
    "b_boathouse", "b_bookstore", "b_booth_indoor", "b_botanical_garden", "b_bow_window_indoor",
    "b_bowling_alley", "b_boxing_ring", "b_bridge", "b_building_facade", "b_bullring",
    "b_burial_chamber", "b_bus_interior", "b_bus_station_indoor", "b_butchers_shop", "b_butte",
    "c_cabin_outdoor", "c_cafeteria", "c_campsite", "c_campus", "c_canal_natural",
    "c_canal_urban", "c_candy_store", "c_canyon", "c_car_interior", "c_carrousel",
    "c_castle", "c_catacomb", "c_cemetery", "c_chalet", "c_chemistry_lab",
    "c_childs_room", "c_church_indoor", "c_church_outdoor", "c_classroom", "c_clean_room",
    "c_cliff", "c_closet", "c_clothing_store", "c_coast", "c_cockpit",
    "c_coffee_shop", "c_computer_room", "c_conference_center", "c_conference_room", "c_construction_site",
    "c_corn_field", "c_corral", "c_corridor", "c_cottage", "c_courthouse",
    "c_courtyard", "c_creek", "c_crevasse", "c_crosswalk", "d_dam",
    "d_delicatessen", "d_department_store", "d_desert_sand", "d_desert_vegetation", "d_desert_road",
    "d_diner_outdoor", "d_dining_hall", "d_dining_room", "d_discotheque", "d_doorway_outdoor",
    "d_dorm_room", "d_downtown", "d_dressing_room", "d_driveway", "d_drugstore",
    "e_elevator_door", "e_elevator_lobby", "e_elevator_shaft", "e_embassy", "e_engine_room",
    "e_entrance_hall", "e_escalator_indoor", "e_excavation", "f_fabric_store", "f_farm",
    "f_fastfood_restaurant", "f_field_cultivated", "f_field_wild", "f_field_road", "f_fire_escape",
    "f_fire_station", "f_fishpond", "f_flea_market_indoor", "f_florist_shop_indoor", "f_food_court",
    "f_football_field", "f_forest_broadleaf", "f_forest_path", "f_forest_road", "f_formal_garden",
    "f_fountain", "g_galley", "g_garage_indoor", "g_garage_outdoor", "g_gas_station",
    "g_gazebo_exterior", "g_general_store_indoor", "g_general_store_outdoor", "g_gift_shop", "g_glacier",
    "g_golf_course", "g_greenhouse_indoor", "g_greenhouse_outdoor", "g_grotto", "g_gymnasium_indoor",
    "h_hangar_indoor", "h_hangar_outdoor", "h_harbor", "h_hardware_store", "h_hayfield",
    "h_heliport", "h_highway", "h_home_office", "h_home_theater", "h_hospital",
    "h_hospital_room", "h_hot_spring", "h_hotel_outdoor", "h_hotel_room", "h_house",
    "h_hunting_lodge_outdoor", "i_ice_cream_parlor", "i_ice_floe", "i_ice_shelf", "i_ice_skating_rink_indoor",
    "i_ice_skating_rink_outdoor", "i_iceberg", "i_igloo", "i_industrial_area", "i_inn_outdoor",
    "i_islet", "j_jacuzzi_indoor", "j_jail_cell", "j_japanese_garden", "j_jewelry_shop",
    "j_junkyard", "k_kasbah", "k_kennel_outdoor", "k_kindergarden_classroom", "k_kitchen",
    "l_lagoon", "l_lake_natural", "l_landfill", "l_landing_deck", "l_laundromat",
    "l_lawn", "l_lecture_room", "l_legislative_chamber", "l_library_indoor", "l_library_outdoor",
    "l_lighthouse", "l_living_room", "l_loading_dock", "l_lobby", "l_lock_chamber",
    "l_locker_room", "m_mansion", "m_manufactured_home", "m_market_indoor", "m_market_outdoor",
    "m_marsh", "m_martial_arts_gym", "m_mausoleum", "m_medina", "m_mezzanine",
    "m_moat_water", "m_mosque_outdoor", "m_motel", "m_mountain", "m_mountain_path",
    "m_mountain_snowy", "m_movie_theater_indoor", "m_museum_indoor", "m_museum_outdoor", "m_music_studio",
    "n_natural_history_museum", "n_nursery", "n_nursing_home", "o_oast_house", "o_ocean",
    "o_office", "o_office_building", "o_office_cubicles", "o_oilrig", "o_operating_room",
    "o_orchard", "o_orchestra_pit", "p_pagoda", "p_palace", "p_pantry",
    "p_park", "p_parking_garage_indoor", "p_parking_garage_outdoor", "p_parking_lot", "p_pasture",
    "p_patio", "p_pavilion", "p_pet_shop", "p_pharmacy", "p_phone_booth",
    "p_physics_laboratory", "p_picnic_area", "p_pier", "p_pizzeria", "p_playground",
    "p_playroom", "p_plaza", "p_pond", "p_porch", "p_promenade",
    "p_pub_indoor", "r_racecourse", "r_raceway", "r_raft", "r_railroad_track",
    "r_rainforest", "r_reception", "r_recreation_room", "r_repair_shop", "r_residential_neighborhood",
    "r_restaurant", "r_restaurant_kitchen", "r_restaurant_patio", "r_rice_paddy", "r_river",
    "r_rock_arch", "r_roof_garden", "r_rope_bridge", "r_ruin", "r_runway",
    "s_sandbox", "s_sauna", "s_schoolhouse", "s_science_museum", "s_server_room",
    "s_shed", "s_shoe_shop", "s_shopfront", "s_shopping_mall_indoor", "s_shower",
    "s_ski_resort", "s_ski_slope", "s_sky", "s_skyscraper", "s_slum",
    "s_snowfield", "s_soccer_field", "s_stable", "s_stadium_baseball", "s_stadium_football",
    "s_stadium_soccer", "s_stage_indoor", "s_stage_outdoor", "s_staircase", "s_storage_room",
    "s_street", "s_subway_station_platform", "s_supermarket", "s_sushi_bar", "s_swamp",
    "s_swimming_hole", "s_swimming_pool_indoor", "s_swimming_pool_outdoor", "s_synagogue_outdoor",
    "t_television_room", "t_television_studio", "t_temple_asia", "t_throne_room", "t_ticket_booth",
    "t_topiary_garden", "t_tower", "t_toyshop", "t_train_interior", "t_train_station_platform",
    "t_tree_farm", "t_tree_house", "t_trench", "t_tundra", "u_underwater_ocean_deep",
    "u_utility_room", "v_valley", "v_vegetable_garden", "v_veterinarians_office", "v_viaduct",
    "v_village", "v_vineyard", "v_volcano", "v_volleyball_court_outdoor", "w_waiting_room",
    "w_water_park", "w_water_tower", "w_waterfall", "w_watering_hole", "w_wave",
    "w_wet_bar", "w_wheat_field", "w_wind_farm", "w_windmill", "y_yard",
    "y_youth_hostel", "z_zen_garden",
]


class SceneClassifier:
    """Classifies scenes using a ResNet-50 Places365 model."""

    def __init__(self, model_path: Optional[str] = None):
        models_dir = os.environ.get(
            "AI_MODELS_DIR", os.path.join(os.path.dirname(__file__), "models")
        )
        path = model_path or os.path.join(models_dir, "resnet50_places365.onnx")

        if not os.path.exists(path):
            raise FileNotFoundError(
                f"Scene classifier model not found at {path}. Run download_models.py first."
            )

        from inference_runtime import InferenceModel
        self.session = InferenceModel("scene", path)
        self.input_name = self.session.get_inputs()[0].name

    def _preprocess(self, image: Image.Image) -> np.ndarray:
        img = image.resize((224, 224), Image.LANCZOS)
        arr = np.array(img, dtype=np.float32)
        # BGR + ImageNet mean subtraction
        arr = arr[:, :, ::-1]
        arr[:, :, 0] -= 103.53
        arr[:, :, 1] -= 116.28
        arr[:, :, 2] -= 123.68
        arr = np.transpose(arr, (2, 0, 1))[np.newaxis, ...]
        return arr

    def classify_image(self, image: Image.Image, top_k: int = 5, min_confidence: float = 0.001) -> List[AiTag]:
        """Classify a decoded image and return top-k scene tags."""
        inp = self._preprocess(image)
        outputs = self.session.run(None, {self.input_name: inp})
        logits = outputs[0][0]
        exp_logits = np.exp(logits - np.max(logits))
        probs = exp_logits / exp_logits.sum()
        top_indices = np.argsort(probs)[::-1][:top_k]
        tags = []
        for idx in top_indices:
            if idx < len(PLACES365_CATEGORIES):
                conf = float(probs[idx])
                if conf < min_confidence:
                    continue
                label = PLACES365_CATEGORIES[idx]
                tags.append(AiTag(label=label, confidence=conf, category="场景", tag_type="ai_scene"))
        return tags

    def classify(self, image_path: str, top_k: int = 5, min_confidence: float = 0.001) -> List[AiTag]:
        """Classify a scene and return top-k tags with confidence above threshold."""
        with Image.open(image_path) as image:
            return self.classify_image(image.convert("RGB"), top_k, min_confidence)
