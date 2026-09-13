// UNIT-TEST FIXTURE ONLY (never evidence for real figures).
// Small combinational cones for gate expansion and equivalence tests.

module cone_top (
  input  logic [5:0] pm,
  input  logic       s1z,
  input  logic       s2z,
  input  logic [7:0] x,
  input  logic [7:0] y,
  input  logic [7:0] z,
  output logic       det,
  output logic       cor,
  output logic       unc,
  output logic       hit,
  output logic       par
);
  logic no_err;
  logic any;

  assign no_err = s1z & s2z;
  assign det    = ~no_err;
  assign any    = |pm;
  assign cor    = det & ~s1z & ~s2z & any;
  assign unc    = det & ~cor;
  assign hit    = (x == 8'h02);
  assign par    = ^(x & y & z);
endmodule
