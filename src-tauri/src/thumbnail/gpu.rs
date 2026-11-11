use image::{DynamicImage, RgbaImage};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, OnceLock,
};
use wgpu::*;

static DEVICE: Mutex<OnceLock<Option<ThumbnailGpu>>> = Mutex::new(OnceLock::new());
static USED: AtomicBool = AtomicBool::new(false);

struct ThumbnailGpu {
    device: Device,
    queue: Queue,
    pipeline: ComputePipeline,
}

pub fn backend_used() -> Option<&'static str> {
    USED.load(Ordering::Relaxed)
        .then_some(if cfg!(target_os = "macos") {
            "Metal"
        } else {
            "Direct3D 12"
        })
}

pub fn resize(image: &DynamicImage, width: u32, height: u32) -> Option<DynamicImage> {
    // Foreground requests can use the CPU while another preview occupies the GPU.
    let mut slot = DEVICE.try_lock().ok()?;
    let gpu = slot.get_or_init(ThumbnailGpu::new).as_ref()?;
    if image.width().max(image.height()) > gpu.device.limits().max_texture_dimension_2d {
        return None;
    }
    match gpu.resize(image, width, height) {
        Some(result) => {
            USED.store(true, Ordering::Relaxed);
            Some(result)
        }
        None => {
            // Fall back for the session if the device is lost or readback fails.
            slot.take();
            let _ = slot.set(None);
            USED.store(false, Ordering::Relaxed);
            None
        }
    }
}

impl ThumbnailGpu {
    fn new() -> Option<Self> {
        let backends = if cfg!(target_os = "macos") {
            Backends::METAL
        } else {
            Backends::DX12
        };
        let instance = Instance::new(&InstanceDescriptor {
            backends,
            ..Default::default()
        });
        let Some(adapter) =
            pollster::block_on(instance.request_adapter(&RequestAdapterOptions::default()))
        else {
            eprintln!("Thumbnail GPU: no hardware adapter available");
            return None;
        };
        if adapter.get_info().device_type == DeviceType::Cpu {
            return None;
        }
        let (device, queue) = pollster::block_on(adapter.request_device(
            &DeviceDescriptor {
                required_limits: Limits::downlevel_defaults().using_resolution(adapter.limits()),
                ..Default::default()
            },
            None,
        ))
        .map_err(|error| eprintln!("Thumbnail GPU: device initialization failed: {error}"))
        .ok()?;
        device.push_error_scope(ErrorFilter::Validation);
        let shader = device.create_shader_module(ShaderModuleDescriptor {
            label: Some("Thumbnail area filter"),
            source: ShaderSource::Wgsl(include_str!("resize.wgsl").into()),
        });
        let pipeline = device.create_compute_pipeline(&ComputePipelineDescriptor {
            label: Some("Thumbnail area filter"),
            layout: None,
            module: &shader,
            entry_point: Some("resize"),
            compilation_options: Default::default(),
            cache: None,
        });
        if let Some(error) = pollster::block_on(device.pop_error_scope()) {
            eprintln!("Thumbnail GPU: pipeline initialization failed: {error}");
            return None;
        }
        device.on_uncaptured_error(Box::new(|error| eprintln!("Thumbnail GPU: {error}")));
        Some(Self {
            device,
            queue,
            pipeline,
        })
    }

    fn resize(&self, image: &DynamicImage, width: u32, height: u32) -> Option<DynamicImage> {
        let source_size = Extent3d {
            width: image.width(),
            height: image.height(),
            depth_or_array_layers: 1,
        };
        let target_size = Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let texture = |size, usage| {
            self.device.create_texture(&TextureDescriptor {
                label: None,
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: TextureDimension::D2,
                format: TextureFormat::Rgba8Unorm,
                usage,
                view_formats: &[],
            })
        };

        let source = texture(
            source_size,
            TextureUsages::COPY_DST | TextureUsages::TEXTURE_BINDING,
        );
        let target = texture(
            target_size,
            TextureUsages::COPY_SRC | TextureUsages::STORAGE_BINDING,
        );
        let rgba = image
            .as_rgba8()
            .map(std::borrow::Cow::Borrowed)
            .unwrap_or_else(|| std::borrow::Cow::Owned(image.to_rgba8()));
        self.queue.write_texture(
            source.as_image_copy(),
            rgba.as_raw(),
            TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(source_size.width * 4),
                rows_per_image: None,
            },
            source_size,
        );

        let source_view = source.create_view(&Default::default());
        let target_view = target.create_view(&Default::default());
        let bind = self.device.create_bind_group(&BindGroupDescriptor {
            label: None,
            layout: &self.pipeline.get_bind_group_layout(0),
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(&source_view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::TextureView(&target_view),
                },
            ],
        });
        let row_bytes = width * 4;
        let stride =
            row_bytes.div_ceil(COPY_BYTES_PER_ROW_ALIGNMENT) * COPY_BYTES_PER_ROW_ALIGNMENT;
        let buffer = self.device.create_buffer(&BufferDescriptor {
            label: None,
            size: u64::from(stride) * u64::from(height),
            usage: BufferUsages::COPY_DST | BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut commands = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = commands.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
        }
        commands.copy_texture_to_buffer(
            target.as_image_copy(),
            TexelCopyBufferInfo {
                buffer: &buffer,
                layout: TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride),
                    rows_per_image: None,
                },
            },
            target_size,
        );
        let submission = self.queue.submit([commands.finish()]);
        let slice = buffer.slice(..);
        let (send, receive) = std::sync::mpsc::channel();
        slice.map_async(MapMode::Read, move |status| {
            let _ = send.send(status);
        });
        let _ = self
            .device
            .poll(Maintain::WaitForSubmissionIndex(submission));
        receive
            .recv_timeout(std::time::Duration::from_secs(2))
            .ok()?
            .ok()?;
        let data = slice.get_mapped_range();
        let mut pixels = Vec::with_capacity(row_bytes as usize * height as usize);
        for row in data.chunks_exact(stride as usize) {
            pixels.extend_from_slice(&row[..row_bytes as usize]);
        }
        RgbaImage::from_raw(width, height, pixels).map(DynamicImage::ImageRgba8)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Kept opt-in so headless CI hosts do not require a physical GPU.
    #[test]
    #[ignore = "requires a hardware GPU"]
    fn area_resize_runs_on_hardware() {
        let mut image = RgbaImage::new(2304, 1200);
        for (x, _, pixel) in image.enumerate_pixels_mut() {
            *pixel = if x < 1152 {
                image::Rgba([40, 80, 120, 255])
            } else {
                image::Rgba([220, 100, 40, 255])
            };
        }
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("input.png");
        image.save(&source).unwrap();
        let thumbnail = crate::thumbnail::generator::generate_thumbnail_with_mode(
            &source,
            directory.path(),
            1024,
            crate::thumbnail::processor::ThumbnailPerformance::Full,
        )
        .unwrap();
        assert!(backend_used().is_some());
        let output = image::open(thumbnail).unwrap().into_rgba8();
        assert_eq!(output.dimensions(), (1024, 533));
        assert_eq!(output.get_pixel(10, 10).0, [40, 80, 120, 255]);
        assert_eq!(output.get_pixel(1000, 500).0, [220, 100, 40, 255]);
    }
}
