import photos from './fixtures/photos.json';
let opened=false;
const project={name:'PhotoFactory · 合成演示资料库',root_path:'/demo/PhotoFactory',created_at:'2025-01-01T00:00:00Z',last_scan:'2025-06-20T09:00:00Z',total_photos:36,thumbnail_threshold_mb:30,ai_models:{face_detection:'retinaface_v1',face_recognition:'arcface_v1',scene_classification:'resnet50_places365'},enabled_extensions:['jpg','png','heic']};
const tags=[{id:1,name:'旅途 · 演示',color:'#5B8DEF',photo_count:12},{id:2,name:'山野 · 演示',color:'#48A899',photo_count:18},{id:3,name:'待整理 · 演示',color:'#D9A34A',photo_count:6}];
const clusters=[{id:1,name:'示例人物 A',face_count:6,photo_count:6,confidence:'high',created_at:1750000000},{id:2,name:'示例人物 B',face_count:6,photo_count:6,confidence:'high',created_at:1750000000}];
const albums=[{id:1,name:'六月手记 · 演示',album_type:'monthly',rule_json:'{}',cover_photo_id:31,photo_count:6,created_at:'2025-06-20',updated_at:'2025-06-20'},{id:2,name:'山野与日落 · 演示',album_type:'themed',rule_json:'{}',cover_photo_id:4,photo_count:18,created_at:'2025-06-20',updated_at:'2025-06-20'},{id:3,name:'示例人物 A',album_type:'person',rule_json:'{}',cover_photo_id:1,photo_count:6,created_at:'2025-06-20',updated_at:'2025-06-20'}];
const page=(items:any[])=>({items,total:items.length,offset:0,has_more:false});
function filter(f:any={}) {return photos.filter(p=>(!f.keyword||JSON.stringify(p).toLowerCase().includes(f.keyword.toLowerCase()))&&(!f.has_favorite||p.is_favorite)&&(!f.rating_min||p.rating>=f.rating_min)&&(!f.year||new Date(p.taken_at*1000).getUTCFullYear()===f.year)&&(!f.month||new Date(p.taken_at*1000).getUTCMonth()+1===f.month)&&(!f.person_id||p.id%6===f.person_id)&&(!f.tag||p.id%3===0)).sort((a,b)=>b.taken_at-a.taken_at)}
export function convertFileSrc(p:string){return p.startsWith('/demo/')&&p.endsWith('.jpg')?`/demo/${Number(p.split('/').pop()?.replace('.jpg',''))}.jpg`:p;}
export async function invoke(cmd:string,a:any={}) : Promise<any> {
 const id=a.photoId??a.clusterId??a.faceId??1;
 switch(cmd){
 case 'cmd_get_project':return opened?project:null;
 case 'cmd_get_last_project_path':return null;
 case 'cmd_get_recent_projects':return ['/demo/PhotoFactory'];
 case 'cmd_open_project':case 'cmd_create_project':opened=true;return project;
 case 'cmd_get_photos':case 'cmd_get_smart_album_photos':{const p=filter(a.filter);return {photos:p,next_cursor:null,has_more:false,total_count:p.length}};
 case 'cmd_get_photo':return photos.find(p=>p.id===id);
 case 'cmd_get_lightbox_photos':return photos;
 case 'cmd_get_thumbnail_path':return `/demo/${id}.jpg`;
 case 'cmd_get_photo_data_url':return convertFileSrc(a.photoPath??'/demo/1.jpg');
 case 'cmd_get_face_thumbnail':case 'cmd_get_cluster_face_thumbnail':return `${location.origin}/demo/${id===2?2:1}.jpg`;
 case 'cmd_get_thumbnail_processing_status':return {running:false,batch_size:0,total_pending:0,processed:0,succeeded:0,failed:0,current_file:null,last_error:null};
 case 'cmd_get_ai_pipeline_status':return {status:'idle',stage:null,processed:0,total:0,failed:0};
 case 'cmd_get_photo_directories':return ['/demo/PhotoFactory/2025'];
 case 'cmd_get_photo_timeline':return [6,5,4,3,2,1].map(month=>({year:2025,month,count:6}));
 case 'cmd_get_photo_filter_options':return {formats:[{value:'jpg',count:36}],cameras:[{value:'DEMO Demo Camera',count:36}],exposure_times:[{value:'1/125',count:36}],iso_min:100,iso_max:400,aperture_min:5.6,aperture_max:5.6};
 case 'cmd_get_photo_classifications':return [{id:1,photo_id:id,category:'自然',label:'山野 · 演示',confidence:.91}];
 case 'cmd_get_photo_attributes':return [{id:1,photo_id:id,key:'说明',value:'合成图 / 非真实拍摄'}];
 case 'cmd_get_photo_faces':return [];
 case 'cmd_get_manual_tags':return tags;
 case 'cmd_get_photo_manual_tags':return tags.slice(0,1);
 case 'cmd_get_all_labels':return [];
 case 'cmd_get_ai_tag_groups':return [{category:'自然',labels:[{label:'山野 · 演示',source:'ai_scene',photo_count:18,average_confidence:.91},{label:'日落 · 演示',source:'ai_semantic',photo_count:12,average_confidence:.85}]},{category:'建筑',labels:[{label:'街景 · 演示',source:'ai_semantic',photo_count:6,average_confidence:.82}]}];
 case 'cmd_get_clusters':return clusters;
 case 'cmd_get_cluster_page':return {items:a.tab==='named'?clusters:[],total:a.tab==='named'?2:0,named_count:2,unnamed_count:0,review_count:0};
 case 'cmd_get_face_detection_count':return 12;
 case 'cmd_get_face_ai_version_status':return {upgrade_available:false};
 case 'cmd_get_thumbnail_performance':return 'balanced';
 case 'cmd_set_thumbnail_performance':return null;
 case 'cmd_worker_health':return false;
 case 'cmd_get_person_detail':return {person_id:id,user_name:`示例人物 ${id===2?'B':'A'}`,face_count:6,confidence:'high',first_seen:'2025-01-01',last_seen:'2025-06-20',cover_photo_id:id};
 case 'cmd_get_person_timeline':case 'cmd_get_person_scene_tags':return [];
 case 'cmd_get_smart_albums':return albums;
 case 'cmd_get_photos_with_gps':return photos.filter(p=>p.latitude!=null);
 case 'cmd_search_map_location':return [{lat:31.234,lng:121.475,display_name:'上海市 · 演示定位（模拟接口）'}];
 case 'cmd_list_offline_maps':return [];
 case 'cmd_get_map_tile_status':return {url:`https://tile.openstreetmap.org/${a.z}/${a.x}/${a.y}.png`,source:'cache'};
 case 'cmd_get_map_tile':return `https://tile.openstreetmap.org/${a.z}/${a.x}/${a.y}.png`;
 case 'cmd_get_library_jobs':return [];
 case 'cmd_get_duplicate_groups':case 'cmd_get_raw_jpeg_stacks':case 'cmd_get_trashed_photos':case 'cmd_get_ignored_faces':return page([]);
 case 'cmd_smart_search':return page(filter());
 case 'cmd_get_story_events':return page([{id:1,name:'六月片段 · 演示',start_at:1748736000,end_at:1750377600,cover_photo_id:31,photo_count:6}]);
 case 'cmd_get_story_photos':return page(photos.slice(30));
 case 'cmd_get_model_plugins':return [{id:'demo-face',name:'人物识别（界面示例）',capability:'face',version:'1.0',enabled:true,status:'available'},{id:'demo-scene',name:'场景分类（界面示例）',capability:'scene',version:'1.0',enabled:true,status:'available'}];
 case 'cmd_get_storage_sources':return [{id:1,path:'/demo/PhotoFactory',label:'演示照片目录',kind:'local',status:'online',read_only:false,last_seen:1750377600,photo_count:36,is_primary:true}];
 case 'cmd_get_library_settings':return {privacy_mode:'true',folder_monitor_enabled:'false',folder_monitor_interval:'60'};
 case 'cmd_has_automatic_face_merge_to_undo':return false;
 case 'cmd_get_ignored_face_count':case 'cmd_get_unassigned_face_count':case 'cmd_get_suspected_face_count':return 0;
 case 'cmd_get_suspected_faces':return [];
 case 'cmd_get_photo_edit':return null;
 case 'cmd_get_photo_count':return 36;
 case 'cmd_toggle_photo_favorite':return true;
 case 'cmd_start_thumbnail_batch':case 'cmd_trigger_auto_ai':return '演示模式：不启动后台分析';
 default: throw new Error(`Unimplemented documentation fixture: ${cmd}`);
 }
}
