import Foundation
import FoundationModels
let instr = try! String(contentsOfFile: "prompts/SC_only.txt", encoding: .utf8)
// Exactly what whisper produces: already punctuated and capitalised.
let cases = [
 "I want to do a meeting at 7. No, at 6.",
 "The deadline is the 15th. No, the 25th.",
 "We need three servers. Actually, four.",
 "Send it to John, I mean Sarah, before Friday.",
 "The price is 200, sorry, 250 dollars.",
 "Book the room for Monday. Scratch that, Tuesday.",
 "Call him at 9. No, make it 10.",
 "There is no reason to change it now.",
 "We need to grab milk and eggs on the way."
]
for c in cases {
    let s = LanguageModelSession(instructions: instr)
    let p = "Transcript to punctuate:\n<<<TRANSCRIPT\n\(c)\nTRANSCRIPT>>>\n\nReturn the punctuated transcript only."
    var out = ""
    do { out = try await s.respond(to: p, options: GenerationOptions(temperature: 0.0)).content }
    catch { out = "[blocked: \(error.localizedDescription.prefix(40))]" }
    out = out.trimmingCharacters(in: .whitespacesAndNewlines)
    print("in : \(c)")
    print("out: \(out)")
    print("")
}
