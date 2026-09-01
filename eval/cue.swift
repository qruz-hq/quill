import Foundation
let cues = ["no","sorry","i mean","actually","rather","instead","scratch that","make it"]
func hasCue(_ t: String) -> Bool {
    let w = t.lowercased()
        .replacingOccurrences(of: "[^a-z0-9 ]", with: " ", options: .regularExpression)
        .replacingOccurrences(of: " +", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespaces)
    return cues.contains { " \(w) ".contains(" \($0) ") }
}
for t in ["I want to do a meeting at 7. No, at 6.",
          "Send it to John, I mean Sarah, before Friday.",
          "The price is 200, sorry, 250 dollars.",
          "We need to grab milk and eggs on the way.",
          "I think the design is coming along nicely.",
          "There is no reason to change it now."] {
    print("\(hasCue(t) ? "CUE " : "  - ") \(t)")
}
