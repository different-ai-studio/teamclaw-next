import SwiftUI
import AMUXCore
import AMUXSharedUI

#if os(iOS)

struct IdeaImageAttachmentStrip: View {
    let urls: [URL]
    let uploads: [String: AttachmentUpload]
    let onRemove: (URL) -> Void

    var body: some View {
        if !urls.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(urls, id: \.self) { url in
                        IdeaLocalImageTile(
                            url: url,
                            upload: uploads[url.absoluteString],
                            onRemove: { onRemove(url) }
                        )
                    }
                }
                .padding(.horizontal, 1)
                .padding(.vertical, 2)
            }
        }
    }
}

struct IdeaActivityImageGrid: View {
    let urls: [URL]

    var body: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 84, maximum: 132), spacing: 8)],
            alignment: .leading,
            spacing: 8
        ) {
            ForEach(urls, id: \.self) { url in
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFill()
                    case .failure:
                        ZStack {
                            Color.amux.pebble
                            Image(systemName: "photo.badge.exclamationmark")
                                .foregroundStyle(Color.amux.slate)
                        }
                    case .empty:
                        ZStack {
                            Color.amux.pebble
                            ProgressView().controlSize(.small)
                        }
                    @unknown default:
                        Color.amux.pebble
                    }
                }
                .frame(height: 96)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(Color.amux.hairline, lineWidth: 0.5)
                )
            }
        }
    }
}

private struct IdeaLocalImageTile: View {
    let url: URL
    let upload: AttachmentUpload?
    let onRemove: () -> Void

    @State private var thumbnail: UIImage?

    private var progress: Double { upload?.progress ?? 0 }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            tileBody
                .frame(width: 58, height: 58)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(Color.amux.hairline, lineWidth: 0.5)
                )
                .overlay(progressOverlay)

            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(Color.amux.mist, Color.amux.onyx.opacity(0.62))
            }
            .buttonStyle(.plain)
            .offset(x: 5, y: -5)
            .accessibilityLabel("Remove image")
        }
        .task(id: url) {
            guard thumbnail == nil else { return }
            thumbnail = await loadThumbnail(from: url)
        }
    }

    @ViewBuilder
    private var tileBody: some View {
        if let thumbnail {
            Image(uiImage: thumbnail)
                .resizable()
                .scaledToFill()
        } else {
            ZStack {
                Color.amux.pebble
                Image(systemName: "photo")
                    .font(.system(size: 18))
                    .foregroundStyle(Color.amux.slate)
            }
        }
    }

    @ViewBuilder
    private var progressOverlay: some View {
        switch upload?.uploadState {
        case .pending, .uploading:
            ZStack {
                Color.amux.onyx.opacity(0.34)
                ProgressView(value: progress)
                    .progressViewStyle(.linear)
                    .tint(Color.amux.mist)
                    .frame(width: 38)
            }
        case .failed:
            ZStack {
                Color.amux.onyx.opacity(0.42)
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Color.amux.cinnabarDeep)
            }
        case .completed, .none:
            EmptyView()
        }
    }

    private func loadThumbnail(from url: URL) async -> UIImage? {
        await Task.detached(priority: .utility) {
            guard let data = try? Data(contentsOf: url),
                  let image = UIImage(data: data) else { return nil }
            let target: CGFloat = 174
            let size = image.size
            let scale = max(target / size.width, target / size.height)
            let newSize = CGSize(width: size.width * scale, height: size.height * scale)
            let renderer = UIGraphicsImageRenderer(size: newSize)
            return renderer.image { _ in
                image.draw(in: CGRect(origin: .zero, size: newSize))
            }
        }.value
    }
}

#endif
