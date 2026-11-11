use core_foundation::{
    base::{CFType, CFTypeRef, TCFType},
    boolean::CFBoolean,
    dictionary::{CFDictionary, CFDictionaryRef},
    number::CFNumber,
    url::{CFURLRef, CFURL},
};
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use image::{DynamicImage, RgbImage};
use std::{ffi::c_void, path::Path, ptr};

#[link(name = "ImageIO", kind = "framework")]
extern "C" {
    static kCGImageSourceCreateThumbnailFromImageAlways: CFTypeRef;
    static kCGImageSourceThumbnailMaxPixelSize: CFTypeRef;
    fn CGImageSourceCreateWithURL(url: CFURLRef, options: CFDictionaryRef) -> CFTypeRef;
    fn CGImageSourceCreateThumbnailAtIndex(
        source: CFTypeRef,
        index: usize,
        options: CFDictionaryRef,
    ) -> CFTypeRef;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGImageGetWidth(image: CFTypeRef) -> usize;
    fn CGImageGetHeight(image: CFTypeRef) -> usize;
    fn CGColorSpaceCreateDeviceRGB() -> CFTypeRef;
    fn CGBitmapContextCreate(
        data: *mut c_void,
        width: usize,
        height: usize,
        bits_per_component: usize,
        bytes_per_row: usize,
        color_space: CFTypeRef,
        info: u32,
    ) -> CFTypeRef;
    fn CGContextDrawImage(context: CFTypeRef, rect: CGRect, image: CFTypeRef);
    fn CGContextRelease(context: CFTypeRef);
}

pub fn thumbnail(path: &Path, size: u32) -> Option<DynamicImage> {
    let url = CFURL::from_path(path, false)?;
    // ImageIO returns a bounded raster in the source's encoded orientation.
    // Face boxes and cached preview coordinates use that same orientation.
    unsafe {
        let source = CGImageSourceCreateWithURL(url.as_concrete_TypeRef(), ptr::null());
        if source.is_null() {
            return None;
        }
        let source = CFType::wrap_under_create_rule(source);
        let options = CFDictionary::from_CFType_pairs(&[
            (
                CFType::wrap_under_get_rule(kCGImageSourceCreateThumbnailFromImageAlways),
                CFBoolean::true_value().as_CFType(),
            ),
            (
                CFType::wrap_under_get_rule(kCGImageSourceThumbnailMaxPixelSize),
                CFNumber::from(size as i32).as_CFType(),
            ),
        ]);
        let image = CGImageSourceCreateThumbnailAtIndex(
            source.as_CFTypeRef(),
            0,
            options.as_concrete_TypeRef(),
        );
        if image.is_null() {
            return None;
        }
        let image = CFType::wrap_under_create_rule(image);
        let width = CGImageGetWidth(image.as_CFTypeRef());
        let height = CGImageGetHeight(image.as_CFTypeRef());
        if width == 0 || height == 0 || width.max(height) > size as usize {
            return None;
        }
        let space = CGColorSpaceCreateDeviceRGB();
        if space.is_null() {
            return None;
        }
        let space = CFType::wrap_under_create_rule(space);
        let mut pixels = vec![0u8; width * height * 4];
        // kCGImageAlphaNoneSkipLast gives RGBX bytes.
        let context = CGBitmapContextCreate(
            pixels.as_mut_ptr().cast(),
            width,
            height,
            8,
            width * 4,
            space.as_CFTypeRef(),
            5,
        );
        if context.is_null() {
            return None;
        }
        CGContextDrawImage(
            context,
            CGRect::new(
                &CGPoint::new(0., 0.),
                &CGSize::new(width as f64, height as f64),
            ),
            image.as_CFTypeRef(),
        );
        CGContextRelease(context);
        let rgb = pixels
            .chunks_exact(4)
            .flat_map(|pixel| [pixel[0], pixel[1], pixel[2]])
            .collect();
        RgbImage::from_raw(width as u32, height as u32, rgb).map(DynamicImage::ImageRgb8)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_io_preserves_raster_dimensions_and_row_order() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("源图.png");
        let image = RgbImage::from_fn(640, 480, |_, y| {
            if y < 240 {
                image::Rgb([220, 40, 40])
            } else {
                image::Rgb([40, 60, 220])
            }
        });
        image.save(&source).unwrap();
        let output = thumbnail(&source, 256).unwrap().into_rgb8();
        assert_eq!(output.dimensions(), (256, 192));
        assert!(output.get_pixel(10, 10)[0] > 180);
        assert!(output.get_pixel(10, 180)[2] > 180);
    }
}
