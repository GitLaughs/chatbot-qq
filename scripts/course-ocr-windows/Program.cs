using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;

if (args.Contains("--self-test"))
{
    WriteJson(new
    {
        ok = OcrEngine.AvailableRecognizerLanguages.Count > 0,
        role = "course_schedule_ocr_provider",
        languages = OcrEngine.AvailableRecognizerLanguages.Select(item => item.LanguageTag).ToArray(),
    });
    return;
}

try
{
    var input = await Console.In.ReadToEndAsync();
    var request = JsonSerializer.Deserialize<OcrRequest>(input, Settings.JsonOptions);
    if (request?.Role != "course_schedule_ocr")
    {
        WriteJson(new { ok = false, reason = "bad_request", detail = "expected role course_schedule_ocr" });
        return;
    }

    var workspace = Path.GetFullPath(request.Context?.Workspace ?? Environment.CurrentDirectory);
    var sources = (request.SourceImages ?? []).Where(item => !string.IsNullOrWhiteSpace(item) && item != "[图片]").Take(8).ToArray();
    if (sources.Length == 0)
    {
        WriteJson(new { ok = false, reason = "no_source_image", detail = "no usable source image was provided" });
        return;
    }

    var engine = CreateOcrEngine();
    if (engine is null)
    {
        WriteJson(new { ok = false, reason = "ocr_language_missing", detail = "no Windows OCR language is available" });
        return;
    }

    var texts = new List<string>();
    foreach (var source in sources)
    {
        var imagePath = await ResolveSourceImageAsync(source, workspace);
        if (string.IsNullOrWhiteSpace(imagePath))
        {
            continue;
        }
        var text = await RecognizeAsync(engine, imagePath);
        if (!string.IsNullOrWhiteSpace(text))
        {
            texts.Add(text.Trim());
        }
    }

    WriteJson(new { ok = true, text = NormalizeOcrText(string.Join(Environment.NewLine, texts)) });
}
catch (Exception ex)
{
    WriteJson(new { ok = false, reason = "ocr_provider_failed", detail = Compact(ex.Message) });
}

static OcrEngine? CreateOcrEngine()
{
    foreach (var tag in new[] { "zh-Hans-CN", "zh-CN", "en-US" })
    {
        try
        {
            var engine = OcrEngine.TryCreateFromLanguage(new Language(tag));
            if (engine is not null) return engine;
        }
        catch
        {
            // Try the next installed language.
        }
    }
    return OcrEngine.TryCreateFromUserProfileLanguages();
}

static async Task<string> ResolveSourceImageAsync(string source, string workspace)
{
    if (Uri.TryCreate(source, UriKind.Absolute, out var uri) && (uri.Scheme == "http" || uri.Scheme == "https"))
    {
        var cacheDir = Path.Combine(workspace, "local_files", "course_ocr_cache");
        Directory.CreateDirectory(cacheDir);
        var ext = Path.GetExtension(uri.AbsolutePath);
        if (!IsImageExtension(ext)) ext = ".jpg";
        var target = Path.Combine(cacheDir, $"{DateTimeOffset.UtcNow:yyyyMMddHHmmss}-{ShortHash(source)}{ext}");
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        var bytes = await client.GetByteArrayAsync(uri);
        await File.WriteAllBytesAsync(target, bytes);
        return target;
    }

    var fullPath = Path.GetFullPath(Path.IsPathRooted(source) ? source : Path.Combine(workspace, source));
    if (!IsPathInside(fullPath, workspace) || !File.Exists(fullPath))
    {
        return "";
    }
    return fullPath;
}

static async Task<string> RecognizeAsync(OcrEngine engine, string imagePath)
{
    var file = await StorageFile.GetFileFromPathAsync(imagePath);
    using var stream = await file.OpenReadAsync();
    var decoder = await BitmapDecoder.CreateAsync(stream);
    using var bitmap = await decoder.GetSoftwareBitmapAsync();
    var result = await engine.RecognizeAsync(bitmap);
    return result.Text ?? "";
}

static string NormalizeOcrText(string value)
{
    var text = value.Replace('：', ':').Replace('－', '-').Replace('—', '-').Replace('–', '-').Replace('~', '-');
    text = Regex.Replace(text, @"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])", "");
    text = Regex.Replace(text, @"\s*:\s*", ":");
    text = Regex.Replace(text, @"(?<=\d)\s+(?=\d)", "");
    text = Regex.Replace(text, @"(?<=\d)\s*[一到至-]\s*(?=\d)", "-");
    text = Regex.Replace(text, @"\s+(?=周[日天一二三四五六]\s*\d{1,2}:)", "；");
    text = Regex.Replace(text, @"[ \t]+", " ");
    return text.Trim();
}

static bool IsPathInside(string targetPath, string rootPath)
{
    var rel = Path.GetRelativePath(Path.GetFullPath(rootPath), Path.GetFullPath(targetPath));
    return rel == "." || (!rel.StartsWith("..") && !Path.IsPathRooted(rel));
}

static bool IsImageExtension(string? ext)
{
    return new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif" }.Contains(ext ?? "");
}

static string ShortHash(string value)
{
    var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
    return Convert.ToHexString(bytes).ToLowerInvariant()[..12];
}

static string Compact(string value)
{
    var text = string.Join(" ", (value ?? "").Split(default(string[]), StringSplitOptions.RemoveEmptyEntries));
    return text.Length <= 240 ? text : text[..240];
}

static void WriteJson(object value)
{
    Console.Out.WriteLine(JsonSerializer.Serialize(value, Settings.JsonOptions));
}

static class Settings
{
    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

sealed class OcrRequest
{
    public string Role { get; set; } = "";
    public string Message { get; set; } = "";
    public string[] SourceImages { get; set; } = [];
    public OcrContext? Context { get; set; }
}

sealed class OcrContext
{
    public string Workspace { get; set; } = "";
}
