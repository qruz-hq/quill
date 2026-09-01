import Foundation
import FoundationModels
let instr = try! String(contentsOfFile: "prompts/SC_only.txt", encoding: .utf8)
let cases = [
 ("i want to do a meeting at 7 no at 6", true),
 ("the deadline is the 15th no the 25th", true),
 ("we need three servers actually four", true),
 ("book the room for monday scratch that tuesday", true),
 ("use postgres i mean mysql for this one", true),
 ("call him at 9 no make it 10", true),
 ("its on the second floor no the third floor", true),
 ("the price is 200 sorry 250 dollars", true),
 ("send it to john i mean sarah before friday", true),
 // must pass through untouched
 ("i want to buy tomatoes potatoes and lettuce", false),
 ("we need to grab milk and eggs on the way", false),
 ("what is the capital of france", false),
 ("i think the design is coming along nicely", false)
]
var ok = 0, total = 0.0
for (c, shouldChange) in cases {
    let s = LanguageModelSession(instructions: instr)
    let p = "<<<\(c)>>>"
    let t0 = Date()
    var content = ""
    var blocked = false
    do { content = try await s.respond(to: p, options: GenerationOptions(temperature: 0.0)).content }
    catch { blocked = true; content = c }   // guardrail or error -> pass through
    let dt = Date().timeIntervalSince(t0); total += dt
    if blocked { print("⚠ GUARDRAIL BLOCKED: \(c)") }
    var out = content.trimmingCharacters(in: .whitespacesAndNewlines)
    if out.hasPrefix("<<<") { out = String(out.dropFirst(3)) }
    if out.hasSuffix(">>>") { out = String(out.dropLast(3)) }
    out = out.trimmingCharacters(in: .whitespacesAndNewlines)
    let low = out.lowercased()
    let leaked = ["no ", "sorry", "i mean", "actually", "scratch that", "make it", "instead", "rather"].contains { low.contains($0) }
    let unchanged = low == c.lowercased()
    let good = shouldChange ? (!leaked && !unchanged) : unchanged
    if good { ok += 1 }
    print("\(good ? "✓" : "✗") \(c)")
    print("   -> \(out)  [\(Int(dt*1000))ms]")
}
print("\ncorrect: \(ok)/\(cases.count)   avg \(Int(total/Double(cases.count)*1000))ms")
