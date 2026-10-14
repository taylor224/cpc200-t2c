/* Minimal H.264 Annex-B access-unit decoder on top of FFmpeg's libavcodec, compiled to
 * WebAssembly with Emscripten (see tools/build-h264dec.sh). One decoder instance per
 * worker. The caller copies a complete access unit (start-code prefixed NAL units) into
 * the WASM heap and calls dec_decode(); when it returns 1 the planes of the decoded
 * frame can be read with dec_plane()/dec_stride() until the next call.
 */
#include <stdint.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavutil/frame.h>
#include <libavutil/log.h>

static AVCodecContext *ctx;
static AVPacket *pkt;
static AVFrame *frame;
static int have_frame;

int dec_init(void) {
    av_log_set_level(AV_LOG_ERROR);
    const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_H264);
    if (!codec) return -1;
    ctx = avcodec_alloc_context3(codec);
    if (!ctx) return -2;
    ctx->flags |= AV_CODEC_FLAG_LOW_DELAY;      /* output every frame as soon as it is decoded */
    ctx->flags2 |= AV_CODEC_FLAG2_FAST;         /* allow non-spec-compliant speedups */
    ctx->thread_count = 1;
    ctx->thread_type = 0;
    if (avcodec_open2(ctx, codec, NULL) < 0) return -3;
    pkt = av_packet_alloc();
    frame = av_frame_alloc();
    if (!pkt || !frame) return -4;
    return 0;
}

/* Returns 1 when a frame is available, 0 when the decoder needs more data,
 * negative AVERROR on failure. */
int dec_decode(uint8_t *data, int len) {
    int r;
    have_frame = 0;
    if (!ctx || len <= 0) return 0;
    av_frame_unref(frame);
    pkt->data = data;
    pkt->size = len;
    pkt->pts = AV_NOPTS_VALUE;
    r = avcodec_send_packet(ctx, pkt);
    if (r < 0 && r != AVERROR(EAGAIN)) return r;
    /* One access unit yields at most one frame (LOW_DELAY, no B-frames). Do not call
     * receive again after success: it would unref the frame before the planes are read. */
    r = avcodec_receive_frame(ctx, frame);
    if (r == 0) { have_frame = 1; return 1; }
    if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) return 0;
    return r;
}

void dec_flush(void) {
    if (ctx) avcodec_flush_buffers(ctx);
    have_frame = 0;
}

int dec_width(void)  { return have_frame ? frame->width : 0; }
int dec_height(void) { return have_frame ? frame->height : 0; }
int dec_format(void) { return have_frame ? frame->format : -1; }         /* AVPixelFormat */
int dec_colorspace(void) { return have_frame ? (int)frame->colorspace : 2; }   /* AVCOL_SPC_* */
int dec_color_range(void) { return have_frame ? (int)frame->color_range : 0; } /* AVCOL_RANGE_* */
int dec_keyframe(void) { return have_frame ? ((frame->flags & AV_FRAME_FLAG_KEY) ? 1 : 0) : 0; }
uint8_t *dec_plane(int i) { return (have_frame && i >= 0 && i < 3) ? frame->data[i] : 0; }
int dec_stride(int i) { return (have_frame && i >= 0 && i < 3) ? frame->linesize[i] : 0; }

void dec_close(void) {
    if (ctx) { avcodec_free_context(&ctx); ctx = 0; }
    if (pkt) av_packet_free(&pkt);
    if (frame) av_frame_free(&frame);
    have_frame = 0;
}
