// A second definition of gen_worker (a simulation stub): dependency
// resolution must report the duplicate and prefer the real module.
module gen_worker (
  input  logic [7:0] op_i,
  output logic [7:0] res_o
);
  assign res_o = 8'h00;
endmodule
