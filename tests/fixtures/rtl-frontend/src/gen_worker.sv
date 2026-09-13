// Combinational worker addressed with a package-qualified width (no import).
module gen_worker (
  input  logic [gen_pkg::W-1:0] op_i,
  output logic [gen_pkg::W-1:0] res_o
);
  assign res_o = op_i ^ 8'h5a;
endmodule
