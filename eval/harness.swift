import Foundation
import FoundationModels

// ---------- corpus ----------
struct Sample: Codable { let id: Int; let cat: String; let text: String; let expect: [String: Bool] }
let corpus = try! JSONDecoder().decode([Sample].self,
    from: Data(contentsOf: URL(fileURLWithPath: "corpus.json")))

// ---------- args ----------
var promptFiles: [String] = [], temps: [Double] = [0.3], limit = Int.max
var wrap = false, shortWrap = false, onlyCats: [String] = []
var it = CommandLine.arguments.dropFirst().makeIterator()
while let a = it.next() {
    switch a {
    case "--prompts": promptFiles = (it.next() ?? "").split(separator: ",").map(String.init)
    case "--temps":   temps = (it.next() ?? "").split(separator: ",").compactMap { Double($0) }
    case "--limit":   limit = Int(it.next() ?? "") ?? .max
    case "--wrap":    wrap = true
    case "--wrapshort": wrap = true; shortWrap = true
    case "--cats":    onlyCats = (it.next() ?? "").split(separator: ",").map(String.init)
    default: break
    }
}
var pool = corpus
if !onlyCats.isEmpty { pool = pool.filter { onlyCats.contains($0.cat) } }
let samples = Array(pool.prefix(limit))

// ---------- guard (mirrors the shipped sanitiser) ----------
func words(_ s: String) -> [String] { s.lowercased().split { !($0.isLetter || $0.isNumber) }.map(String.init) }

func near(_ a: String, _ b: String, max limit: Int = 2) -> Bool {
    if a == b { return true }
    if abs(a.count - b.count) > limit { return false }
    let x = Array(a), y = Array(b)
    var prev = Array(0...y.count), cur = [Int](repeating: 0, count: y.count + 1)
    for i in 1...x.count {
        cur[0] = i
        for j in 1...y.count { cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1] + (x[i-1]==y[j-1] ? 0:1)) }
        if cur.min()! > limit { return false }
        swap(&prev, &cur)
    }
    return prev[y.count] <= limit
}

let META = ["here is","here's","i apolog","sure","corrected version","cleaned text","output","certainly","of course"]
let REFUSAL = ["i cannot","i can't","i'm sorry","i am sorry","i won't","as an ai","i'm unable","i am unable"]

func strip(_ out: String) -> String {
    var t = out.trimmingCharacters(in: .whitespacesAndNewlines)
    for _ in 0..<3 {
        let lower = t.lowercased()
        guard META.contains(where: { lower.hasPrefix($0) }) else { break }
        if let c = t.firstIndex(of: ":"), t.distance(from: t.startIndex, to: c) < 80 { t = String(t[t.index(after: c)...]) }
        else if let n = t.firstIndex(of: "\n") { t = String(t[t.index(after: n)...]) }
        else { break }
        t = t.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    if t.count > 1, t.hasPrefix("\""), t.hasSuffix("\"") { t = String(t.dropFirst().dropLast()) }
    return t.trimmingCharacters(in: .whitespacesAndNewlines)
}

struct Verdict { let text: String; let fellBack: Bool; let coverage: Double; let fixRate: Double }

func judge(_ raw: String, _ out: String) -> Verdict {
    let t = strip(out)
    if t.isEmpty { return Verdict(text: raw, fellBack: true, coverage: 0, fixRate: 0) }
    let filler: Set<String> = ["um","uh","er","ah","like","you","know","i","mean","so","ok","okay",
                               "first","second","third","fourth","fifth",
                               // retraction cues - the speaker meant these to vanish
                               "no","sorry","actually","rather","instead","scratch","nevermind"]
    // A retraction also deletes the thing being retracted, so allow more slack.
    let cues = ["no ", " no ", "sorry", "i mean", "actually", "scratch that", "instead", "rather"]
    let lowRaw = raw.lowercased()
    let selfCorrecting = cues.contains { lowRaw.contains($0) }
    let src = words(raw), dstArr = words(t), dst = Set(dstArr)
    let content = src.filter { !filler.contains($0) }
    guard !content.isEmpty else { return Verdict(text: t, fellBack: false, coverage: 1, fixRate: 0) }
    var exact = 0, corrected = 0
    for w in content {
        if dst.contains(w) { exact += 1 }
        else if dstArr.contains(where: { near(w, $0) }) { corrected += 1 }
    }
    let cov = Double(exact + corrected) / Double(content.count)
    let fix = Double(corrected) / Double(content.count)
    let growth = Double(dstArr.count) / Double(max(src.count, 1))
    let bad = cov < 0.70 || fix > 0.35 || growth > 1.5
    return Verdict(text: bad ? raw : t, fellBack: bad, coverage: cov, fixRate: fix)
}

func hasBullets(_ s: String) -> Bool {
    s.split(separator: "\n").contains { l in
        let t = l.trimmingCharacters(in: .whitespaces)
        return t.hasPrefix("- ") || t.hasPrefix("• ") || (t.count > 2 && t.first!.isNumber && t.dropFirst().hasPrefix("."))
    }
}

// ---------- run ----------
struct Row { var n = 0, fallback = 0, refused = 0, answered = 0, listMiss = 0, listWrong = 0, meta = 0
             var cov = 0.0, secs = 0.0 }

print("prompt,temp,n,fallback%,refused%,answeredQ%,listMiss%,falseList%,meta%,avgCov,avgSec")

for pf in promptFiles {
    let instructions = try! String(contentsOfFile: "prompts/\(pf).txt", encoding: .utf8)
    for temp in temps {
        var r = Row()
        var failures: [String] = []
        for s in samples {
            // Fresh session per sample: sessions retain history.
            let session = LanguageModelSession(instructions: instructions)
            let t0 = Date()
            var raw = ""
            // Wrapping puts the transcript in the position of DATA rather than a message
// addressed to the model, which is what triggers refusals and answers.
let payload: String
if shortWrap      { payload = "<<<\(s.text)>>>" }
else if wrap      { payload = "Transcript to punctuate:\n<<<TRANSCRIPT\n\(s.text)\nTRANSCRIPT>>>\n\nReturn the punctuated transcript only." }
else              { payload = s.text }
do { raw = try await session.respond(to: payload, options: GenerationOptions(temperature: temp)).content }
            catch { raw = "" }
            let dt = Date().timeIntervalSince(t0)
            let v = judge(s.text, raw)
            let low = raw.lowercased()

            r.n += 1; r.secs += dt; r.cov += v.coverage
            if v.fellBack { r.fallback += 1 }
            if REFUSAL.contains(where: { low.contains($0) }) { r.refused += 1; failures.append("REFUSE [\(s.cat)] \(s.text) -> \(raw.prefix(70))") }
            if META.contains(where: { low.hasPrefix($0) }) { r.meta += 1 }
            if s.expect["question"] == true, !v.text.contains("?") { r.answered += 1; failures.append("ANSWERED [\(s.cat)] \(s.text) -> \(v.text.prefix(70))") }
            if s.expect["list"] == true, !hasBullets(v.text) { r.listMiss += 1 }
            if s.expect["list"] == false, hasBullets(v.text) { r.listWrong += 1 }
        }
        let n = Double(r.n)
        func pc(_ x: Int) -> String { String(format: "%.0f", Double(x)/n*100) }
        print("\(pf),\(temp),\(r.n),\(pc(r.fallback)),\(pc(r.refused)),\(pc(r.answered)),\(pc(r.listMiss)),\(pc(r.listWrong)),\(pc(r.meta)),\(String(format: "%.2f", r.cov/n)),\(String(format: "%.2f", r.secs/n))")
        FileHandle.standardError.write(("--- \(pf) @\(temp) failures ---\n" + failures.prefix(8).joined(separator: "\n") + "\n").data(using: .utf8)!)
    }
}
