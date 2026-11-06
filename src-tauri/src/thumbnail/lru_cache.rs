use lru::LruCache;
use std::num::NonZeroUsize;
use std::sync::Mutex;

pub struct ThumbnailLruCache {
    cache: Mutex<LruCache<String, String>>,
}

impl ThumbnailLruCache {
    pub fn new(max_size: usize) -> Self {
        Self {
            cache: Mutex::new(LruCache::new(NonZeroUsize::new(max_size).unwrap())),
        }
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.cache.lock().unwrap().get(key).cloned()
    }

    pub fn put(&self, key: String, value: String) {
        self.cache.lock().unwrap().put(key, value);
    }

    pub fn pop_lru(&self) -> Option<(String, String)> {
        self.cache.lock().unwrap().pop_lru()
    }

    pub fn len(&self) -> usize {
        self.cache.lock().unwrap().len()
    }
}

// Global cache instance -- max 500 entries
pub static THUMBNAIL_LRU: once_cell::sync::Lazy<ThumbnailLruCache> =
    once_cell::sync::Lazy::new(|| ThumbnailLruCache::new(500));
