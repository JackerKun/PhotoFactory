@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn resize(@builtin(global_invocation_id) invocation: vec3<u32>) {
    let target_size = textureDimensions(output);
    if (any(invocation.xy >= target_size)) {
        return;
    }

    let source_size = textureDimensions(source, 0);
    let scale = vec2<f32>(source_size) / vec2<f32>(target_size);
    let start = vec2<f32>(invocation.xy) * scale;
    let end = vec2<f32>(invocation.xy + vec2<u32>(1)) * scale;
    let first = vec2<i32>(floor(start));
    let last = min(vec2<i32>(ceil(end)), vec2<i32>(source_size));
    var accumulated = vec4<f32>(0.0);

    // Weight each source pixel by the fraction covered by this output pixel.
    for (var y = first.y; y < last.y; y += 1) {
        let wy = min(end.y, f32(y + 1)) - max(start.y, f32(y));
        for (var x = first.x; x < last.x; x += 1) {
            let wx = min(end.x, f32(x + 1)) - max(start.x, f32(x));
            let pixel = textureLoad(source, vec2<i32>(x, y), 0);
            accumulated += vec4<f32>(pixel.rgb * pixel.a, pixel.a) * (wx * wy);
        }
    }
    let alpha = accumulated.a / (scale.x * scale.y);
    let color = accumulated.rgb / max(accumulated.a, 0.000001);
    textureStore(output, vec2<i32>(invocation.xy), vec4<f32>(color, alpha));
}
