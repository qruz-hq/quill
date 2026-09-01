import Foundation
import FoundationModels
let which = CommandLine.arguments[1]
let instr = try! String(contentsOfFile: "prompts/\(which).txt", encoding: .utf8)
// None of these appear in P6's examples.
let cases = [
 "i want to do a meeting at 7 no at 6",
 "the deadline is the 15th no the 25th",
 "we need three servers actually four",
 "book the room for monday scratch that tuesday",
 "use postgres i mean mysql for this one",
 "call him at 9 no make it 10",
 "its on the second floor no the third floor",
 "the price is 200 sorry 250 dollars",
 "send it to john i mean sarah before friday",
 // regressions
 "i want to buy tomatoes potatoes and lettuce",
 "we need to grab milk and eggs on the way",
 "what is the capital of france"
]
var ok = 0
for c in cases {
    let s = LanguageModelSession(instructions: instr)
    let p = "Transcript to punctuate:\n<<<TRANSCRIPT\n\(c)\nTRANSCRIPT>>>\n\nReturn the punctuated transcript only."
    let r = try await s.respond(to: p, options: GenerationOptions(temperature: 0.0))
    let out = r.content.trimmingCharacters(in: .whitespacesAndNewlines)
    let low = out.lowercased()
    let leaked = ["no,","no ","sorry","i mean","actually","scratch that","make it"].contains { low.contains($0) }
    let mark = leaked ? "✗" : "✓"
    if !leaked { ok += 1 }
    print("\(mark) \(c)")
    print("   -> \(out.replacingOccurrences(of: "\n", with: " ⏎ "))")
}
print("\nclean: \(ok)/\(cases.count)")
